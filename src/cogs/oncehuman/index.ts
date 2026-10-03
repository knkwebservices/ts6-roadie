import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { GameDb, gameDbCommand } from '../../util/gamedb.js';

export const manifest: CogManifest = {
  name: 'oncehuman',
  version: '1.0.0',
  description: 'Once Human lookups from oncehumandb.com: !oh <name>',
};

export const ONCE_HUMAN_SECTIONS = ['weapons', 'armor', 'armor-sets', 'mods', 'attachments', 'items', 'deviations', 'memetics', 'identities', 'recipes', 'cradle-overrides', 'overrides'];

export function createOnceHumanCog(bot: BotApi, site?: GameDb): Cog {
  const db = site ?? new GameDb({ base: 'https://www.oncehumandb.com', sections: ONCE_HUMAN_SECTIONS });
  return {
    commands: [
      gameDbCommand(bot, {
        name: 'oncehuman',
        game: 'Once Human',
        command: 'oh',
        aliases: ['oncehuman'],
        site: db,
        prefer: ['weapon', 'armor', 'deviation', 'mod', 'item', 'attachment', 'armor-set', 'recipe', 'identity', 'memetic', 'cradle-override'],
        credit: 'Data from Once Human DB (oncehumandb.com)',
        example: 'Doombringer',
      }),
    ],
    status: () => 'Once Human lookups from oncehumandb.com',
  };
}

const factory: CogFactory = (bot) => createOnceHumanCog(bot);
export default factory;
