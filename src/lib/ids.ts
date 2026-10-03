import type { Config } from '../config';
import type { Privacy } from '../shared/constants';

/** The 64 animals of upstream MicroBin (6 bits per word, so `byte & 63` is unbiased). */
export const ANIMALS = [
  'ant',
  'eel',
  'mole',
  'sloth',
  'ape',
  'emu',
  'monkey',
  'snail',
  'bat',
  'falcon',
  'mouse',
  'snake',
  'bear',
  'fish',
  'otter',
  'spider',
  'bee',
  'fly',
  'parrot',
  'squid',
  'bird',
  'fox',
  'panda',
  'swan',
  'bison',
  'frog',
  'pig',
  'tiger',
  'camel',
  'gecko',
  'pigeon',
  'toad',
  'cat',
  'goat',
  'pony',
  'turkey',
  'cobra',
  'goose',
  'pug',
  'turtle',
  'crow',
  'hawk',
  'rabbit',
  'viper',
  'deer',
  'horse',
  'rat',
  'wasp',
  'dog',
  'jaguar',
  'raven',
  'whale',
  'dove',
  'koala',
  'seal',
  'wolf',
  'duck',
  'lion',
  'shark',
  'worm',
  'eagle',
  'lizard',
  'sheep',
  'zebra',
] as const;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** `words` random animals, e.g. "sloth-bee-falcon-pig" (6 bits of entropy per word). */
export function randomAnimalId(words: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(words));
  return Array.from(bytes, (byte) => ANIMALS[byte & 63]).join('-');
}

/** Short random id from an unambiguous alphabet (rejection sampling: no modulo bias). */
export function randomShortId(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 232 && out.length < length) out += BASE58[byte % 58];
    }
  }
  return out;
}

/**
 * Levels where the link is the only protection (the content is readable by anyone who has it).
 * Their ids must not be guessable, so they never get fewer than 48 bits of randomness.
 */
const LINK_ONLY: readonly Privacy[] = ['unlisted', 'readonly'];
export const LINK_ONLY_ANIMAL_WORDS = 8; // 8 x 6 bit = 48 bit
export const LINK_ONLY_SHORT_CHARS = 12; // 12 x 5.86 bit = ~70 bit

export function newId(config: Pick<Config, 'hashIds' | 'idLength'>, privacy: Privacy): string {
  const strong = LINK_ONLY.includes(privacy);
  return config.hashIds
    ? randomShortId(strong ? Math.max(config.idLength, LINK_ONLY_SHORT_CHARS) : config.idLength)
    : randomAnimalId(strong ? Math.max(config.idLength, LINK_ONLY_ANIMAL_WORDS) : config.idLength);
}

const ID_PATTERN = /^(?:[a-z]{2,10}(?:-[a-z]{2,10}){0,15}|[1-9A-HJ-NP-Za-km-z]{4,40})$/;

/** Cheap shape check done before touching the database. */
export function isValidId(id: string): boolean {
  return id.length <= 200 && ID_PATTERN.test(id);
}
