const { dispatchCommand } = require('../src/lib/command-dispatcher');

describe('command dispatcher', () => {
  test('supports commands that only accept interaction', async () => {
    const cmd = {
      data: { name: 'only-interaction' },
      execute: jest.fn(async (interaction) => {
        return { ok: true, interaction };
      })
    };

    const interaction = { id: 'i1' };
    const client = { id: 'c1' };
    const db = { id: 'd1' };

    const res = await dispatchCommand(cmd, interaction, { client, db }, 'x', 'y');
    expect(cmd.execute).toHaveBeenCalledWith(interaction, client, db, 'x', 'y');
    expect(res.ok).toBe(true);
  });

  test('supports commands that accept interaction, client, db', async () => {
    const cmd = {
      data: { name: 'with-client-db' },
      execute: jest.fn(async (interaction, client, db) => {
        return { interaction, client, db };
      })
    };

    const interaction = { id: 'i2' };
    const client = { id: 'c2' };
    const db = { id: 'd2' };

    const res = await dispatchCommand(cmd, interaction, { client, db });
    expect(cmd.execute).toHaveBeenCalledWith(interaction, client, db);
    expect(res.client.id).toBe('c2');
  });

  test('supports future optional args', async () => {
    const cmd = {
      data: { name: 'future-args' },
      execute: jest.fn(async (interaction, client, db, extra1, extra2) => {
        return { interaction, client, db, extra1, extra2 };
      })
    };

    const interaction = { id: 'i3' };
    const client = { id: 'c3' };
    const db = { id: 'd3' };

    const res = await dispatchCommand(cmd, interaction, { client, db }, { foo: 1 }, 123);
    expect(cmd.execute).toHaveBeenCalledWith(interaction, client, db, { foo: 1 }, 123);
    expect(res.extra2).toBe(123);
  });

  test('throws on invalid command module', async () => {
    await expect(dispatchCommand({ data: { name: 'bad' } }, {}, {})).rejects.toThrow(/missing execute/);
  });
});
