import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronDown, CornerUpLeft, Loader2, MessageSquare, Smile, Trash2 } from 'lucide-react';
import { useRole } from '../../hooks/useRole';
import { sessionApi, type Chat } from '../../services/api';
import {
  buildMentionNameMap,
  getMediaSrc,
  resolveMentions,
  senderKey,
  type ChatMessageView,
} from '../../utils/chatMessages';
import { shouldFetchOlderMessages } from '../../utils/scrollDecision';
import { keepsSameKey } from '../../utils/authLifecycle';
import ArchivedMediaPreview, { type ArchivedMediaKind } from './ArchivedMediaPreview';
import MessageBody from './MessageBody';

// Stable per-sender colour for group message labels, like WhatsApp gives each participant a colour.
// Hashed from the sender's name so the same person keeps the same colour across a session. The palette
// is tuned to stay legible on both the light and dark incoming-bubble backgrounds.
const SENDER_COLORS = ['#d1416f', '#7c5cff', '#0a86c4', '#1a8f5c', '#c26a00', '#c0392b', '#0e7c86', '#8e44ad'];
const senderColor = (name: string): string => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
};

interface ChatThreadProps {
  /** Needed to fetch a message's media on demand; null before a session is chosen. */
  sessionId: string | null;
  activeChat: Chat;
  messages: ChatMessageView[];
  loadingMessages: boolean;
  messagesError: boolean;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  /** Whether an older page of this chat's history exists. */
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  onLoadOlderMessages: () => void;
  onMediaLoad: (event?: { currentTarget: Element | null }) => void;
  /** Seeds each media element's pre-decode height; see useChatScrollPosition.measureMedia. */
  measureMedia: (el: Element | null) => void;
  onOpenImage: (messageId: string) => void;
  onReply: (message: ChatMessageView) => void;
  onReact: (message: ChatMessageView, emoji: string) => void;
  onDelete: (message: ChatMessageView) => void;
  /** Tap a choice on an inbound business button/list prompt (Baileys click-button). */
  onClickButton: (message: ChatMessageView, button: { id: string; text: string }) => Promise<void>;
}

// The messages area of the active chat room: the bubble list (media, quotes, reactions, hover
// actions) plus the floating scroll-to-bottom button. The page owns the message query and the
// scroll-position hook (its containerRef is handed down); reply/react/delete/lightbox intents go
// back up as callbacks.
/** The WhatsApp id of the message a bubble belongs to, which outlives the key React gives its element. */
const waIdOf = (element: HTMLElement): string | null =>
  element.closest('[data-wa-message-id]')?.getAttribute('data-wa-message-id') ?? null;

function ChatThread({
  sessionId,
  activeChat,
  messages,
  loadingMessages,
  messagesError,
  messagesContainerRef,
  hasMoreMessages,
  loadingOlderMessages,
  onLoadOlderMessages,
  onMediaLoad,
  measureMedia,
  onOpenImage,
  onReply,
  onReact,
  onDelete,
  onClickButton,
}: ChatThreadProps) {
  const { t } = useTranslation();
  // Reply, react, delete and prompt taps all need an operator key, like the composer; a viewer
  // would only reach a 403.
  const { canWrite } = useRole();

  // The message actions sit behind hover, so a keyboard user reaches them through the bubble that carries
  // them: the bubbles are one tab stop (the focused message, else the newest), the arrow keys move between
  // them, and the actions show while keyboard focus is inside a bubble (Chats.css). Links, previews and
  // buttons inside a message stay stops of their own.
  const hasActions = useCallback(
    (message: ChatMessageView) => canWrite && message.type !== 'revoked' && Boolean(message.waMessageId),
    [canWrite],
  );
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const tabStopId = useMemo(() => {
    if (focusedMessageId && messages.some(m => m.id === focusedMessageId && hasActions(m))) return focusedMessageId;
    for (let i = messages.length - 1; i >= 0; i--) if (hasActions(messages[i])) return messages[i].id;
    return null;
  }, [messages, focusedMessageId, hasActions]);
  const onBubbleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only the bubble itself: a key pressed on an action button, the reaction popover or a link keeps
    // its own meaning.
    if (event.target !== event.currentTarget) return;
    const stops = Array.from(
      messagesContainerRef.current?.querySelectorAll<HTMLElement>('[data-roving-message]') ?? [],
    );
    const at = stops.indexOf(event.currentTarget);
    const target =
      event.key === 'ArrowUp'
        ? stops[at - 1]
        : event.key === 'ArrowDown'
          ? stops[at + 1]
          : event.key === 'Home'
            ? stops[0]
            : event.key === 'End'
              ? stops[stops.length - 1]
              : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  // The message control that holds keyboard focus, with its bubble and the stops on either side of it.
  // When that control is the one that goes away (a deleted message's actions unmount, or its bubble loses
  // its tab stop) focus falls to the page, and the next Tab would land in the composer: it moves to the stop
  // that took the place of the bubble instead. React delivers no blur for an element it removes, so the
  // element is checked after the commit, and only once: a later change of the list never moves focus, and
  // the position of a reader who scrolled away is never touched (preventScroll). Focus a pointer brought
  // in is not recorded, so a mouse click on Delete moves nothing. The place is found from the bubble in the
  // document, not from an index taken at focus time, which an older page landing since would have moved.
  const keyboardFocusRef = useRef<{
    element: HTMLElement;
    bubble: HTMLElement;
    wa: string | null;
    neighbors: Array<{ element: HTMLElement; wa: string | null }>;
  } | null>(null);
  useEffect(() => {
    const held = keyboardFocusRef.current;
    if (!held) return;
    const stopOf = (element: HTMLElement) => element.isConnected && element.closest('[data-roving-message]') !== null;
    const stillStop = stopOf(held.element);
    // Lost: focus fell to the page, or it still sits on an element that has just stopped being a stop,
    // which Firefox and WebKit only clear a frame later, in a focusout that would reset what is held here.
    const active = document.activeElement;
    if (active !== document.body && !(active === held.element && !stillStop)) return;
    keyboardFocusRef.current = null;
    if (stillStop) return;
    const { bubble } = held;
    const stops = Array.from(
      messagesContainerRef.current?.querySelectorAll<HTMLElement>('[data-roving-message]') ?? [],
    );
    // A bubble that left the document may be the same message under a new key (a refetch replaces the
    // live copy of a message with its stored row): the WhatsApp id on its wrapper says so.
    const byWa = (wa: string | null) => (wa ? stops.find(stop => waIdOf(stop) === wa) : undefined);
    // The control alone may have gone (a link an edit removed, a media control swapped for its marker): the
    // message it belonged to is still a stop, and keeps the focus.
    const target =
      bubble.isConnected && bubble.hasAttribute('data-roving-message')
        ? bubble
        : bubble.isConnected
          ? (stops.find(stop => bubble.compareDocumentPosition(stop) & bubble.DOCUMENT_POSITION_FOLLOWING) ??
            [...stops]
              .reverse()
              .find(stop => bubble.compareDocumentPosition(stop) & bubble.DOCUMENT_POSITION_PRECEDING))
          : (byWa(held.wa) ??
            held.neighbors
              .map(near =>
                near.element.isConnected && near.element.hasAttribute('data-roving-message')
                  ? near.element
                  : byWa(near.wa),
              )
              .find(Boolean));
    target?.focus({ preventScroll: true });
  }, [messages, hasActions, messagesContainerRef]);

  // "@<digits>" in a message body only ever means something once resolved against a participant
  // this thread has already seen post (see buildMentionNameMap) — recomputed only when the message
  // list itself changes, not per-render.
  const mentionNames = useMemo(() => buildMentionNameMap(messages), [messages]);

  // Media the message list did not inline. The route serves the bytes as an attachment
  // (Content-Disposition), and the list only carries payloads up to
  // MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES — past that a row arrives as `{ omitted: true }`. Without
  // this fetch the placeholder is terminal: this thread requests the largest page size and caches it
  // with staleTime Infinity, so an older attachment in a media-heavy chat has no other route to it.
  // Keyed by message id, not one shared slot: a viewer can click a second placeholder before the
  // first resolves, and each download owns its own lifecycle. Sharing one slot let the second click
  // overwrite the first, after which whichever settled first cleared the other's state — re-enabling
  // a button whose fetch was still open, and landing a failure marker on the wrong bubble.
  const [mediaFetch, setMediaFetch] = useState<Record<string, 'loading' | 'failed'>>({});
  // In-flight / completed taps on inbound prompt buttons. Keyed by waMessageId so a second click on
  // another choice of the same prompt is blocked while one request is open, and after success the
  // row reads as answered (WhatsApp treats a prompt as single-choice once answered).
  //
  // Client-side and per-visit only: this is reset when the active chat changes, and a reload starts
  // it empty, so an answered prompt becomes clickable again. Nothing below this component refuses a
  // second answer, and WhatsApp accepts it as another reply to the same prompt, so the flag is a
  // courtesy against a double click rather than a guarantee; making it durable means persisting the
  // answered state with the message, not widening this state.
  const [buttonClick, setButtonClick] = useState<
    Record<string, { loadingId?: string; done?: boolean; selectedId?: string }>
  >({});
  const downloadMedia = useCallback(
    async (message: ChatMessageView) => {
      const messageId = message.waMessageId;
      if (!sessionId || !messageId) return;
      setMediaFetch(prev => ({ ...prev, [messageId]: 'loading' }));
      let objectUrl: string | null = null;
      const sameKey = keepsSameKey();
      try {
        const blob = await sessionApi.getMessageMediaBlob(sessionId, activeChat.id, messageId);
        if (!sameKey()) return;
        objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        // The stored filename when there is one; the message id is a unique fallback that keeps two
        // downloads from the same thread apart.
        link.download = message.metadata?.media?.filename || messageId;
        link.click();
        setMediaFetch(prev => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
      } catch {
        // 404 covers every "there are no bytes" case the route documents (URL-based send, media
        // download disabled, over the inbound cap). Say so on the bubble rather than failing mutely.
        setMediaFetch(prev => ({ ...prev, [messageId]: 'failed' }));
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    },
    [sessionId, activeChat.id],
  );

  const handleClickButton = useCallback(
    async (message: ChatMessageView, button: { id: string; text: string }) => {
      const key = message.waMessageId || message.id;
      if (!key) return;
      let blocked = false;
      setButtonClick(prev => {
        if (prev[key]?.loadingId || prev[key]?.done) {
          blocked = true;
          return prev;
        }
        return { ...prev, [key]: { loadingId: button.id } };
      });
      if (blocked) return;
      try {
        await onClickButton(message, button);
        setButtonClick(prev => ({ ...prev, [key]: { done: true, selectedId: button.id } }));
      } catch {
        // Parent already toasts; clear the in-flight state so the user can retry.
        setButtonClick(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [onClickButton],
  );

  // Scroll-to-bottom button visibility. The main scroll-position memory is owned by
  // useChatScrollPosition, which doesn't expose its pin state (intentionally — that would re-render
  // the whole room on every scroll). This small listener tracks only the boolean "user is far from
  // the bottom" so we can float the jump button.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return undefined;
    const onScroll = (event?: Event) => {
      // 120px gap = a couple of message bubbles before counting as "scrolled up".
      setShowJumpToBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
      const geometry = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      if (
        shouldFetchOlderMessages({
          isUserScroll: Boolean(event),
          geometry,
          hasMore: hasMoreMessages,
          isFetching: loadingOlderMessages,
        })
      ) {
        onLoadOlderMessages();
      }
    };
    onScroll(); // sync initial position (e.g. saved restore landed above the bottom)
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

  const handleJumpToBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Instant, not smooth: an older page that lands during the animation writes the scroll position and
    // cancels it, which left the reader thousands of pixels above the bottom. The landing keeps an instant
    // jump in place (useChatScrollPosition).
    el.scrollTo({ top: el.scrollHeight });
  }, [messagesContainerRef]);

  // Reset the jump button whenever the active chat changes: the new chat's content is restored by
  // useChatScrollPosition and our listener will resync on its first scroll tick. The prompt-answer
  // map goes with it: its ids belong to the chat being left, and holding them would disable a
  // button in the chat being entered if the two ever shared a message id.
  useEffect(() => {
    setShowJumpToBottom(false);
    setButtonClick({});
  }, [activeChat?.id]);

  // Helper formats
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div
      className="room-messages"
      ref={messagesContainerRef}
      // The actions show while focus is inside a bubble, but only for keyboard focus: a click also focuses
      // the bubble, and its menu would stay drawn over the message after the pointer left. The marker is
      // read by Chats.css. It follows the focus itself as well as the pointer and the keys: a key pressed
      // outside the thread is never seen here, and a click on a native audio or video control sends the
      // page no pointer event at all, though it focuses the element.
      onPointerDown={event => event.currentTarget.setAttribute('data-pointer', '')}
      onKeyDown={event => event.currentTarget.removeAttribute('data-pointer')}
      onFocus={event => {
        const target = event.target;
        const bubble = target.closest<HTMLElement>('[data-roving-message]');
        const keyboard = target.matches(':focus-visible');
        if (keyboard) event.currentTarget.removeAttribute('data-pointer');
        else event.currentTarget.setAttribute('data-pointer', '');
        if (!keyboard || !bubble) {
          keyboardFocusRef.current = null;
          return;
        }
        const stops = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-roving-message]'));
        const at = stops.indexOf(bubble);
        const neighbors = [stops[at + 1], stops[at - 1]]
          .filter((stop): stop is HTMLElement => Boolean(stop))
          .map(stop => ({ element: stop, wa: waIdOf(stop) }));
        keyboardFocusRef.current = { element: target, bubble, wa: waIdOf(bubble), neighbors };
      }}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) keyboardFocusRef.current = null;
      }}
    >
      {/* Older-page spinner, or the failure in its place. An in-flow sibling before the thread, not
          an overlay — it pushes the oldest bubble down, which is why useChatScrollPosition reads
          this container's height at REQUEST time (before this renders), not on whichever commit
          happens to change it first. Shown whenever there IS a thread to sit above — including a
          failed older-page fetch with messages already loaded, which must not fall through to the
          full-screen error below: that would replace the loaded thread with a placeholder,
          collapsing the scroll container so the failed page can never be retried by scrolling. */}
      {!loadingMessages && (loadingOlderMessages || (messagesError && messages.length > 0)) && (
        <div className="messages-loading-older">
          {loadingOlderMessages ? (
            <>
              <Loader2 className="animate-spin" size={18} />
              <span>{t('chats.loadingOlderMessages')}</span>
            </>
          ) : (
            <>
              <AlertCircle size={18} />
              <span>{t('chats.loadOlderMessagesError')}</span>
            </>
          )}
        </div>
      )}
      {loadingMessages ? (
        <div className="messages-loading">
          <Loader2 className="animate-spin" size={32} />
          <span>{t('chats.loadingMessages')}</span>
        </div>
      ) : messagesError && messages.length === 0 ? (
        <div className="messages-empty">
          <MessageSquare size={32} />
          <span>{t('chats.loadMessagesError')}</span>
        </div>
      ) : messages.length === 0 ? (
        <div className="messages-empty">
          <MessageSquare size={32} />
          <span>{t('chats.noMessagesInChat')}</span>
        </div>
      ) : (
        messages.map((msg, index) => {
          const isMe = msg.direction === 'outgoing';
          const formattedTime = formatTime(msg.timestamp || Math.floor(new Date(msg.createdAt).getTime() / 1000));

          // Label who posted, WhatsApp-style: only in groups, only on incoming messages,
          // and only on the first of a consecutive run from the same sender (so a burst
          // from one person isn't repeated on every bubble).
          const prev = messages[index - 1];
          const showSender = Boolean(
            activeChat?.isGroup &&
            !isMe &&
            msg.chatName &&
            // Key the run on the stable sender id (participant JID), not the display
            // name — two participants who share a pushName must still start a new run.
            (!prev || prev.direction === 'outgoing' || senderKey(prev) !== senderKey(msg)),
          );

          const isMediaMessage = msg.type !== 'text';
          const mediaInfo = msg.metadata?.media;
          const displayBody = msg.body || (msg.type === 'poll' ? msg.metadata?.poll?.name : undefined);

          const renderMedia = () => {
            if (msg.type === 'revoked') return null;
            // location/call have no downloadable media payload — render them before the
            // mediaInfo gate. The raw body (a base64 thumbnail / empty token) is suppressed below.
            if (msg.type === 'location') {
              // WhatsApp location messages carry a base64 JPEG map-preview thumbnail in `body`.
              const thumb = msg.body && msg.body.length > 100 ? `data:image/jpeg;base64,${msg.body}` : '';
              return (
                <div className="message-location">
                  {thumb && (
                    <img ref={measureMedia} src={thumb} alt="" onLoad={onMediaLoad} className="chat-location-media" />
                  )}
                  <span className="message-media-omitted">📍 {t('chats.media.location')}</span>
                </div>
              );
            }
            if (msg.type === 'call') {
              const call = msg.metadata?.call;
              const callKey = call?.video
                ? call.missed
                  ? 'callVideoMissed'
                  : 'callVideo'
                : call?.missed
                  ? 'callMissed'
                  : 'call';
              return (
                <div className="message-media-omitted">
                  {`${call?.video ? '📹' : '📞'} ${t(`chats.media.${callKey}`)}`}
                </div>
              );
            }
            if (!mediaInfo) return null;
            if (mediaInfo.omitted) {
              // Not a plain label: the bytes exist behind the per-message media route, so this is the
              // only handle the viewer has on them.
              const fetchState = msg.waMessageId ? mediaFetch[msg.waMessageId] : undefined;
              const downloadButton = (
                <button
                  type="button"
                  className="message-media-omitted"
                  onClick={() => void downloadMedia(msg)}
                  disabled={!sessionId || !msg.waMessageId || fetchState === 'loading'}
                >
                  {fetchState === 'loading' ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <>📎 {t(fetchState === 'failed' ? 'chats.status.mediaUnavailable' : 'chats.media.omitted')}</>
                  )}
                </button>
              );
              // `archived` marks a copy MESSAGE_INLINE_MEDIA=archive moved off the row once the archive
              // store held it: the bubble rendered inline before, so it previews inline still, fetched
              // lazily from the same route. Documents keep the button (there is nothing to preview),
              // and so does a plain over-budget marker, see ArchivedMediaPreview for why.
              const previewKind: ArchivedMediaKind | null =
                msg.type === 'image' || msg.type === 'sticker'
                  ? 'image'
                  : msg.type === 'video'
                    ? 'video'
                    : msg.type === 'audio' || msg.type === 'voice'
                      ? 'audio'
                      : null;
              const waMessageId = msg.waMessageId;
              if (mediaInfo.archived && previewKind && sessionId && waMessageId) {
                return (
                  <ArchivedMediaPreview
                    key={`${sessionId}:${activeChat.id}:${waMessageId}`}
                    kind={previewKind}
                    load={signal => sessionApi.getMessageMediaBlob(sessionId, activeChat.id, waMessageId, signal)}
                    alt={mediaInfo.filename || t('chats.media.image')}
                    filename={mediaInfo.filename}
                    id={msg.id}
                    scrollRootRef={messagesContainerRef}
                    fallback={downloadButton}
                    measureMedia={measureMedia}
                    onMediaLoad={onMediaLoad}
                  />
                );
              }
              return downloadButton;
            }
            const mediaSrc = getMediaSrc(mediaInfo);
            if (!mediaSrc) return null;

            switch (msg.type) {
              case 'image':
              case 'sticker':
                return (
                  <div className="message-media-image">
                    <img
                      src={mediaSrc}
                      alt={mediaInfo.filename || t('chats.media.image')}
                      className="chat-image-media"
                      ref={measureMedia}
                      onLoad={onMediaLoad}
                      onClick={() => onOpenImage(msg.id)}
                    />
                  </div>
                );
              case 'video':
                return (
                  <div className="message-media-video">
                    <video
                      ref={measureMedia}
                      src={mediaSrc}
                      controls
                      className="chat-video-media"
                      onLoadedData={onMediaLoad}
                    />
                  </div>
                );
              case 'audio':
              case 'voice':
                return (
                  <div className="message-media-audio">
                    <audio src={mediaSrc} controls className="chat-audio-media" />
                  </div>
                );
              case 'document':
              default:
                return (
                  <div className="message-media-document">
                    {/* A document sent by URL links off-site, where browsers ignore `download`, so a plain
                        click would navigate the dashboard away; open it in a new tab instead. */}
                    <a
                      href={mediaSrc}
                      download={mediaInfo.filename || 'document'}
                      className="chat-document-media"
                      {...(/^https?:\/\//i.test(mediaSrc) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      📎 {mediaInfo.filename || t('chats.downloadDocument')}
                    </a>
                  </div>
                );
            }
          };

          const reactions = msg.metadata?.reactions || {};
          const hasReactions = Object.keys(reactions).length > 0;
          const isRevoked = msg.type === 'revoked';
          const isMasked = msg.type === 'masked';

          return (
            <div
              key={msg.id}
              className={`message-bubble-wrapper ${isMe ? 'outgoing' : 'incoming'}`}
              data-wa-message-id={msg.waMessageId}
              data-scroll-anchor=""
            >
              <div
                className="message-bubble-container"
                {...(hasActions(msg)
                  ? {
                      'data-roving-message': '',
                      tabIndex: tabStopId === msg.id ? 0 : -1,
                      // Only focus on the bubble itself: a link or a button inside it is a stop of its own and
                      // must not turn the bubble into the thread's tab stop as well.
                      onFocus: (event: FocusEvent<HTMLDivElement>) => {
                        if (event.target === event.currentTarget) setFocusedMessageId(msg.id);
                      },
                      onKeyDown: onBubbleKeyDown,
                    }
                  : {})}
              >
                <div
                  className={`message-bubble ${isMe ? 'outgoing' : 'incoming'} ${msg.status} ${
                    isMediaMessage ? 'media-type' : ''
                  } ${isRevoked ? 'revoked-type' : ''}`}
                >
                  {/* Group sender label (WhatsApp-style: coloured name atop the bubble) */}
                  {/* Group sender label (WhatsApp-style: coloured name atop the bubble).
                      Colour keys on the stable sender id, so same-named participants
                      still get distinct colours; the label shows the human name. */}
                  {showSender && (
                    <div className="message-sender" style={{ color: senderColor(senderKey(msg)!) }}>
                      {msg.chatName}
                    </div>
                  )}

                  {/* Quoted message display */}
                  {msg.metadata?.quotedMessage && (
                    <div className="message-quote-box">
                      <MessageBody
                        text={resolveMentions(msg.metadata.quotedMessage.body, mentionNames)}
                        className="quote-body"
                      />
                    </div>
                  )}

                  {renderMedia()}

                  {isRevoked ? (
                    <div className="message-text">{t('chats.messageDeleted')}</div>
                  ) : isMasked ? (
                    <div className="message-text message-masked">{t('chats.messageMasked')}</div>
                  ) : (
                    displayBody &&
                    (!mediaInfo || displayBody !== mediaInfo.filename) &&
                    msg.type !== 'location' &&
                    msg.type !== 'call' && (
                      <MessageBody text={resolveMentions(displayBody, mentionNames)} className="message-text" />
                    )
                  )}

                  {!isRevoked && msg.type === 'poll' && (msg.metadata?.poll?.options?.length ?? 0) > 0 && (
                    <ul className="message-text" aria-label={t('messageTester.pollOptions')}>
                      {msg.metadata!.poll!.options.map((option, index) => (
                        <li key={index}>
                          <bdi>{option}</bdi>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Inbound business prompt choices; a tap calls POST .../messages/click-button. */}
                  {!isMe && !isRevoked && !isMasked && (msg.metadata?.buttons?.length ?? 0) > 0 && (
                    <div className="message-prompt-buttons" role="group" aria-label={t('chats.promptButtons')}>
                      {msg.metadata!.buttons!.map((btn, idx) => {
                        const clickKey = msg.waMessageId || msg.id;
                        const state = buttonClick[clickKey];
                        const loading = state?.loadingId === btn.id;
                        const disabled = Boolean(state?.loadingId || state?.done);
                        return (
                          <button
                            key={`${idx}:${btn.id}`}
                            type="button"
                            className={`message-prompt-button${state?.selectedId === btn.id ? ' selected' : ''}${state?.done ? ' answered' : ''}`}
                            disabled={disabled || !canWrite}
                            onClick={() => void handleClickButton(msg, btn)}
                          >
                            {loading ? <Loader2 size={14} className="animate-spin" /> : btn.text}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="message-meta">
                    <span className="message-time">{formattedTime}</span>
                    {/* delivered and read render the SAME glyph and differ only in colour, which
                        carries the meaning nowhere a screen reader or a colour-blind reader can
                        reach it. The status is spelled out for both. */}
                    {isMe && (
                      <span
                        className={`message-status-icon ${msg.status}`}
                        role="img"
                        aria-label={t(`chats.messageStatus.${msg.status}`)}
                        title={t(`chats.messageStatus.${msg.status}`)}
                      >
                        {msg.status === 'pending' && '🕒'}
                        {msg.status === 'sent' && '✓'}
                        {msg.status === 'delivered' && '✓✓'}
                        {msg.status === 'read' && '✓✓'}
                        {msg.status === 'failed' && '⚠️'}
                      </span>
                    )}
                  </div>

                  {/* Reactions display */}
                  {hasReactions && (
                    <div className="message-reactions-badge">
                      {Object.values(reactions)
                        .slice(0, 3)
                        .map((emoji, idx) => (
                          <span key={idx} className="reaction-emoji-span">
                            {emoji}
                          </span>
                        ))}
                      {Object.keys(reactions).length > 1 && (
                        <span className="reactions-count-span">{Object.keys(reactions).length}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Message actions menu (hover, or focus inside the bubble). Every action addresses the message by its WhatsApp
                    id, so an optimistic bubble still on its local temp_ id (pending, or failed for
                    good) offers none: the gateway could never resolve it. */}
                {canWrite && !isRevoked && Boolean(msg.waMessageId) && (
                  <div className="message-actions-menu">
                    <button
                      type="button"
                      className="action-btn"
                      onClick={() => onReply(msg)}
                      title={t('chats.actions.reply')}
                    >
                      <CornerUpLeft size={14} />
                    </button>

                    <div className="reaction-trigger-wrapper">
                      <button type="button" className="action-btn reaction-btn" title={t('chats.actions.react')}>
                        <Smile size={14} />
                      </button>
                      <div className="reaction-quick-popover">
                        {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => (
                          <button key={emoji} type="button" onClick={() => onReact(msg, emoji)}>
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>

                    {isMe && msg.status !== 'pending' && (
                      <button
                        type="button"
                        className="action-btn delete-btn"
                        onClick={() => onDelete(msg)}
                        title={t('chats.actions.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
      {/* Floating scroll-to-bottom button. The LAST child, so that `position: sticky; bottom` holds it at
          the bottom of the visible pane while the thread scrolls under it: absolutely positioned inside
          the scroller it moved with the content and was off screen whenever it was shown. Hidden while
          loading (no height to measure yet) and when the user is already at/near the bottom. */}
      {showJumpToBottom && !loadingMessages && (
        <button
          type="button"
          className="scroll-to-bottom-btn"
          onClick={handleJumpToBottom}
          aria-label={t('chats.scrollToBottom')}
          title={t('chats.scrollToBottom')}
        >
          <ChevronDown size={22} />
        </button>
      )}
    </div>
  );
}

export default ChatThread;
