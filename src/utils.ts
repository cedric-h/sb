/* handy lil utils */

export const ids = { ship: "C0M8PUPU6" };

export const sum = (arr: number[]) => arr.reduce((a, x) => a + x);


/* turns a string into a valid user id or throws an error */
export const normUserId = (id: string) => {
  const match = id.match(/^<@([a-zA-Z0-9]+)(?:\|.+)?>$/);
  if (match && match.length >= 2)
    return `<@${match[1]}>`;
  if (/^[a-zA-Z0-9]+$/.test(id))
    return `<@${id}>`;
  throw new Error("couldn't normalize user id: " + id);
}
export const isUserId = (id: string) => {
  return /^<@([a-zA-Z0-9]+)(?:\|.+)?>$/.test(id) || /^[a-zA-Z0-9]+$/.test(id);
}


/* handles [de]serializing data that might contain maps */
export const serialize = (x: any) => JSON.stringify(x, (_, v) => {
  if (v.__proto__ == Map.prototype)
    return { "__prototype__": "Map", "data": Object.fromEntries(v.entries()) };
  return v;
});
export const deserialize = (x: string) => JSON.parse(x, (_, v) => {
  if (v.__prototype__ == "Map")
    return new Map(Object.entries(v.data));
  return v;
});