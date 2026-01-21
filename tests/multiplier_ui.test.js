jest.setTimeout(10000);
function makeInteraction(sub='multiplier-list'){
  const reply = jest.fn();
  const options = { getSubcommand: () => sub, getUser: (k) => null };
  const interaction = { options, reply, user: { id: 'R1', tag: 'Recruiter#0001' }, member: { permissions: { has: () => true } } };
  return { interaction, reply };
}

describe('multiplier UI', () => {
  test('multiplier-list replies with embed', async () => {
    const { interaction } = makeInteraction('multiplier-list');
    const cmd = require('../src/commands/recruiter.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalled();
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.embeds).toBeTruthy();
  });

  test('multiplier-view shows no multiplier when none set', async () => {
    const { interaction } = makeInteraction('multiplier-view');
    const cmd = require('../src/commands/recruiter.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalled();
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.embeds[0].data.title).toMatch(/Multiplier for/);
  });
});
