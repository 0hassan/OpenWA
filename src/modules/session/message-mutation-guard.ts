import { MessageDirection } from '../message/entities/message.entity';
import { parseWaId } from '../../engine/identity/wa-id';

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

/**
 * What two spellings of one phone number share: its digits, without a '+', spaces or dashes, and without
 * the mobile marker digit that the id WhatsApp reports for a Brazilian, Mexican or Argentine number
 * drops, which a REST caller usually types (a send stores the chat id as its caller wrote it).
 */
function phoneKey(local: string): string {
  return local
    .replace(/\D/g, '')
    .replace(/^55(\d{2})9(\d{8})$/, '55$1$2')
    .replace(/^521(\d{10})$/, '52$1')
    .replace(/^549(\d+)$/, '54$1');
}

/**
 * The entity an id names, whatever its dialect: a phone (`@c.us`, `@s.whatsapp.net`, hosted, a `:device`
 * form or a bare number, which is how the send routes may have stored it), a lid, a group or a list.
 * Null for an id this cannot place, which proves nothing.
 */
function entityOf(jid: string): { kind: string; id: string } | null {
  const parsed = parseWaId(jid);
  if (parsed.kind === 'user') return { kind: 'user', id: phoneKey(parsed.userPart) };
  if (parsed.kind !== 'unknown') return { kind: parsed.kind, id: parsed.userPart };
  return !jid.includes('@') && /^\+?\d[\d \-]*$/.test(jid.trim()) ? { kind: 'user', id: phoneKey(jid) } : null;
}

const isPerson = (kind: string): boolean => kind === 'user' || kind === 'lid';

/**
 * Whether two ids provably name different chats or people, compared by the entity they name rather than
 * by dialect or spelling. A lid against a phone number may be one person.
 */
export function provablyDifferent(a?: string | null, b?: string | null): boolean {
  if (!a || !b || a === b) return false;
  const left = entityOf(a);
  const right = entityOf(b);
  if (!left || !right) return false;
  if (left.kind === right.kind) return left.id !== right.id;
  return !(isPerson(left.kind) && isPerson(right.kind));
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
