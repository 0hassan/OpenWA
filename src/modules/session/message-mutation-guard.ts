import { MessageDirection } from '../message/entities/message.entity';

/** What a stored row says about whose message it is and where it lives. */
export interface StoredMessageRef {
  chatId: string;
  direction: MessageDirection;
  author?: string | null;
}

/** What an inbound edit, revoke or reaction says about who made it and where. */
export interface MutationSource {
  kind: 'edit' | 'revoke' | 'reaction';
  chatId: string;
  /** Whether the account itself made the change, from its phone; undefined when the engine does not say. */
  fromMe?: boolean;
  /** For a group edit, the participant who wrote the message being edited. */
  author?: string;
}

const isLid = (jid: string): boolean => jid.endsWith('@lid');
const isPhone = (jid: string): boolean => jid.endsWith('@c.us');

/** Whether two neutral ids provably name different chats or people. A lid against a phone number may be one. */
function provablyDifferent(a?: string | null, b?: string | null): boolean {
  if (!a || !b || a === b) return false;
  return !((isLid(a) && isPhone(b)) || (isLid(b) && isPhone(a)));
}

/**
 * Why a change must not touch the stored row it names, or null when it may.
 *
 * Baileys applies no validation to an edit, a revoke or a reaction: it hands over whatever a participant
 * sent, naming any message id the sender knows. The engine adapter checks it against its own message
 * store, which holds the newest few thousand messages and never a history-synced one, so for an older
 * message only this row can tell. WhatsApp clients ignore a change made by somebody other than the
 * author, so applying it would make the gateway's record say what no client shows.
 *
 *  - `chat`: a message id belongs to one chat.
 *  - `direction`: an edit, and a revoke in a one-to-one chat, come from the author only, so a change
 *    made by the counterparty cannot name a message the account sent, nor the reverse. Group revokes are
 *    exempt, since an admin may delete anyone's message.
 *  - `author`: a group edit comes from the participant who wrote the message.
 */
export function mutationTargetsForeignRow(
  row: StoredMessageRef,
  source: MutationSource,
): 'chat' | 'direction' | 'author' | null {
  if (provablyDifferent(row.chatId, source.chatId)) return 'chat';
  const group = source.chatId.endsWith('@g.us') || row.chatId.endsWith('@g.us');
  const authorOnly = source.kind === 'edit' || (source.kind === 'revoke' && !group);
  if (authorOnly && source.fromMe !== undefined) {
    const expected = source.fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING;
    if (row.direction && row.direction !== expected) return 'direction';
  }
  if (source.kind === 'edit' && group && source.fromMe === false && provablyDifferent(row.author, source.author)) {
    return 'author';
  }
  return null;
}
