import { MessageDirection } from '../message/entities/message.entity';
import { mutationTargetsForeignRow } from './message-mutation-guard';

const OUT = MessageDirection.OUTGOING;
const IN = MessageDirection.INCOMING;

describe('mutationTargetsForeignRow', () => {
  const direct = '628111@c.us';
  const group = '120363000000000001@g.us';

  it('lets a change made by the sender of a one-to-one message through', () => {
    expect(
      mutationTargetsForeignRow({ chatId: direct, direction: IN }, { kind: 'edit', chatId: direct, fromMe: false }),
    ).toBeNull();
    expect(
      mutationTargetsForeignRow({ chatId: direct, direction: OUT }, { kind: 'revoke', chatId: direct, fromMe: true }),
    ).toBeNull();
  });

  it('refuses a one-to-one edit or revoke made by the other party', () => {
    for (const kind of ['edit', 'revoke'] as const) {
      expect(
        mutationTargetsForeignRow({ chatId: direct, direction: OUT }, { kind, chatId: direct, fromMe: false }),
      ).toBe('direction');
      expect(mutationTargetsForeignRow({ chatId: direct, direction: IN }, { kind, chatId: direct, fromMe: true })).toBe(
        'direction',
      );
    }
  });

  it('refuses a change that names a message of another chat, whatever the kind', () => {
    for (const kind of ['edit', 'revoke', 'reaction'] as const) {
      expect(mutationTargetsForeignRow({ chatId: group, direction: IN }, { kind, chatId: direct })).toBe('chat');
      expect(mutationTargetsForeignRow({ chatId: direct, direction: IN }, { kind, chatId: group })).toBe('chat');
      expect(
        mutationTargetsForeignRow({ chatId: '120363000000000002@g.us', direction: IN }, { kind, chatId: group }),
      ).toBe('chat');
    }
  });

  // A REST send keeps the number as its caller wrote it ('+', spaces, no mobile marker digit) while the
  // engine reports the canonical one.
  it('reads the spellings of one phone number as one chat', () => {
    const spellings: Array<[string, string]> = [
      ['+628111@c.us', '628111@c.us'],
      ['62 811 1@c.us', '628111@c.us'],
      ['5511987654321@c.us', '551187654321@c.us'],
      ['5215512345678@c.us', '525512345678@c.us'],
      ['5491123456789@c.us', '541123456789@c.us'],
    ];
    for (const [stored, reported] of spellings) {
      expect(
        mutationTargetsForeignRow({ chatId: stored, direction: OUT }, { kind: 'reaction', chatId: reported }),
      ).toBeNull();
    }
  });

  it('still calls two different phone numbers different chats', () => {
    for (const stored of ['628222@c.us', '+628222@s.whatsapp.net', '628222', '551187654322@c.us']) {
      expect(
        mutationTargetsForeignRow({ chatId: stored, direction: IN }, { kind: 'reaction', chatId: '628111@c.us' }),
      ).toBe('chat');
    }
  });

  it('does not call a lid and a phone number different, since they may be one chat', () => {
    expect(
      mutationTargetsForeignRow({ chatId: '111@lid', direction: IN }, { kind: 'edit', chatId: direct, fromMe: false }),
    ).toBeNull();
    expect(
      mutationTargetsForeignRow({ chatId: direct, direction: IN }, { kind: 'edit', chatId: '111@lid', fromMe: false }),
    ).toBeNull();
    expect(
      mutationTargetsForeignRow(
        { chatId: '111@lid', direction: IN },
        { kind: 'edit', chatId: '222@lid', fromMe: false },
      ),
    ).toBe('chat');
  });

  // The send routes store the chat id as the caller wrote it, in either dialect the docs give, while the
  // engines report the neutral one.
  it('reads the id a REST send stored in any dialect of the chat as the same chat', () => {
    for (const stored of ['628111@s.whatsapp.net', '628111', '628111:7@s.whatsapp.net', '628111@C.US']) {
      for (const kind of ['reaction', 'edit', 'revoke'] as const) {
        expect(
          mutationTargetsForeignRow({ chatId: stored, direction: OUT }, { kind, chatId: direct, fromMe: true }),
        ).toBeNull();
      }
    }
    expect(mutationTargetsForeignRow({ chatId: '628111', direction: OUT }, { kind: 'reaction', chatId: group })).toBe(
      'chat',
    );
  });

  it('lets any participant react, and an admin delete a message the account sent', () => {
    expect(
      mutationTargetsForeignRow({ chatId: group, direction: OUT }, { kind: 'reaction', chatId: group, fromMe: false }),
    ).toBeNull();
    expect(
      mutationTargetsForeignRow({ chatId: group, direction: OUT }, { kind: 'revoke', chatId: group, fromMe: false }),
    ).toBeNull();
  });

  it('refuses a group edit by somebody other than the author, and one of the account message by a member', () => {
    const row = { chatId: group, direction: IN, author: '628111@c.us' };
    expect(
      mutationTargetsForeignRow(row, { kind: 'edit', chatId: group, fromMe: false, author: '628111@c.us' }),
    ).toBeNull();
    expect(mutationTargetsForeignRow(row, { kind: 'edit', chatId: group, fromMe: false, author: '628222@c.us' })).toBe(
      'author',
    );
    expect(
      mutationTargetsForeignRow({ chatId: group, direction: OUT }, { kind: 'edit', chatId: group, fromMe: false }),
    ).toBe('direction');
  });

  it('says nothing when the engine does not say who made the change', () => {
    expect(
      mutationTargetsForeignRow({ chatId: direct, direction: OUT }, { kind: 'revoke', chatId: direct }),
    ).toBeNull();
  });
});
