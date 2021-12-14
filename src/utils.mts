import { CustomError } from "ts-custom-error";

/* handy lil utils */

export const ids = { ship: "C0M8PUPU6" };

export const sum = (arr: number[]) => arr.reduce((a, x) => a + x, 0);

export class BadInput extends CustomError {}

export const levelNames: string[] = (
    "Lamella Egg Skink Eosinopteryx Salamander Common_Lizard Komodo Crocodile" +
    " Dimetrodon Triceratops Stegosaurus Pterodactyl Wyvern Brontosaurus Dragon Hydra" +
    " Tyrannosaurus_Rex Gallus_gallus_domesticus Orpheus"
  ).split(' ').map(x => x.replace(/_/g, " "));
export const levelXp: number[] = [
  0, 1.25e3, 4.9e3, 1.44e4, 5.6e4, 2.1e5, 8.1e5, 3.2e6, 9.7e8, 1.27e7,
  5.0e7, 1.88e8, 666666661, 2.3e9, 9.9e9, 4.3e10, 8.2e10, 1.1e11, 7.3e11, 1.0e12
];
export const xpData = (xp: number) => {
  let i; for (i = 0; xp >= levelXp[i]; i++);
  return {
    levelNeedsTotal: levelXp[i],
    goal: levelXp[i] - levelXp[i - 1],
    prog: xp - levelXp[i - 1],
    levelName: levelNames[i - 1],
    index: i,
  };
};
export const progBar = (size: number, ratio: number) => "`\u{2062}" +
  [...Array(size)].map((_, i) => i/size < ratio ? '\u{2588}' : ' ').join('') +
  "\u{2062}`";

/* turns a string into a valid user id or throws an error */
export const fullIdRegex = /^<@([a-zA-Z0-9]+)(?:\|.+)?>$/;
export const normUserId = (id: string) => {
  const match = id.match(fullIdRegex);
  if (match && match.length >= 2)
    return `<@${match[1]}>`;
  if (/^[a-zA-Z0-9]+$/.test(id))
    return `<@${id}>`;
  throw new BadInput("couldn't normalize user id: " + id);
}
export const stripId = (id: string) => {
  const match = id.match(fullIdRegex);
  if (match && match[1]) return match[1];
}
export const isUserId = (id: string) => {
  return fullIdRegex.test(id) || /^[a-zA-Z0-9]+$/.test(id);
}


/* handles [de]serializing data that might contain maps */
export const serialize = (x: any) => JSON.stringify(x, (_, v) => {
  if (v && v.__proto__ == Map.prototype)
    return { "__prototype__": "Map", "data": Object.fromEntries(v.entries()) };
  if (v && v.__proto__ == Set.prototype)
    return { "__prototype__": "Set", "data": [...v] };
  return v;
});
export const deserialize = (x: string) => JSON.parse(x, (_, v) => {
  if (v.__prototype__ == "Map") return new Map(Object.entries(v.data));
  if (v.__prototype__ == "Set") return new Set(v.data);
  return v;
});
