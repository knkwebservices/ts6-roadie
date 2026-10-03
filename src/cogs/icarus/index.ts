import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { GameDb, gameDbCommand } from '../../util/gamedb.js';

export const manifest: CogManifest = {
  name: 'icarus',
  version: '1.0.0',
  description: 'Icarus lookups from icarusdatabase.com: !icarus <name>',
};

export const ICARUS_SECTIONS = ['items', 'recipes', 'talents', 'creatures', 'stations', 'armor-sets', 'biomes', 'missions', 'buffs', 'accolades', 'fish', 'farming', 'workshop', 'alterations'];

export function createIcarusCog(bot: BotApi, site?: GameDb): Cog {
  const db = site ?? new GameDb({ base: 'https://www.icarusdatabase.com', sections: ICARUS_SECTIONS });
  return {
    commands: [
      gameDbCommand(bot, {
        name: 'icarus',
        game: 'Icarus',
        command: 'icarus',
        aliases: ['ic'],
        site: db,
        prefer: ['item', 'creature', 'recipe', 'talent'],
        credit: 'Data from Icarus Database (icarusdatabase.com)',
        example: 'compound bow',
      }),
    ],
    status: () => 'Icarus lookups from icarusdatabase.com',
  };
}

const factory: CogFactory = (bot) => createIcarusCog(bot);
export default factory;
