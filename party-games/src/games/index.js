import br31 from "./br31.js";
import updown from "./updown.js";
import liar from "./liar.js";
import nunchi from "./nunchi.js";
import reaction from "./reaction.js";
import rps from "./rps.js";
import omok from "./omok.js";

export const GAME_LIST = [liar, nunchi, reaction, rps, br31, updown, omok];
export const GAMES = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));

export function catalog() {
  return GAME_LIST.map(({ id, name, emoji, min, max, short, rules }) => ({ id, name, emoji, min, max, short, rules }));
}
