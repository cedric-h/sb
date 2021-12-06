import { sum, serialize, deserialize, normUserId, ids } from "./utils";
import { Reaction } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { RespondFn } from "@slack/bolt/dist/types/utilities";
import { App } from "@slack/bolt";
import fs from "fs";

/* we're taking reactions out of the context of their original message,
 * so there's some of that context that we need to save */
type React = Reaction & { msg: string };

/* shipmoji are reaction emojis placed on ships.
 *
 * this function gives you a cached shipMoji if it's still pipin' hot, otherwise buckle
 * in because we're fetching a new one for ya!
 * 
 * the #1 goal is to return relevant info, the #2 goal is to not refresh unless there is
 * a need to do so. a faster but less relevant version of this could return stale info,
 * but I think it's better to be slow and accurate rather than fast and inaccurate.
 *
 * exported for use in passgo.ts */
const shipMoji: ((app: App) => Promise<Map<string, React[]>>) = (() => {
  let shipMoji: Map<string, React[]>,
      lastCache: number;

  const file = "../shipmojiCache.json";
  try {
    ({ lastCache, shipMoji } = deserialize(fs.readFileSync(file, "utf-8")));
  } catch(e) {
    console.log("couldn't find " + file + ": " + e);
  }

  const fetchShipmoji = async (app: App) => {
    console.log("fetching shipMoji ...");

    shipMoji = new Map();
    lastCache = Date.now();

    for (let res, cursor; !res || res.has_more; cursor = res.response_metadata!.next_cursor!) {
      res = await app.client.conversations.history({
        channel: ids.ship,
        limit: 1000,
        /* cutoff point: https://hackclub.slack.com/archives/C0M8PUPU6/p1564202710161200 
         * (seemed like people actually kept ship threaded after that point) */
        oldest: "1564202710.161200",
        cursor,
      });
      if (!res.ok) throw new Error(res.error!);

      for (const msg of res.messages!) {
        /* we can't find the most popular reaction on reactionless messages */
        if (!msg.reactions || msg.reactions.length == 0) continue;

        const user = `<@${msg.user!}>`;
        const userShipmoji = shipMoji.get(user) ?? [];

        /* push only the most popular reaction */
        const reacts = msg.reactions.reduce((a, x) => (x.count! > a.count!) ? x : a);
        userShipmoji.push(Object.assign(reacts, { msg: msg.ts! }));

        shipMoji.set(user, userShipmoji);
      }
    }

    fs.writeFileSync(file, serialize({ lastCache, shipMoji }), "utf-8");

    return shipMoji;
  };

  return async (app: App) => {
    if (shipMoji == undefined || (Date.now() - lastCache) > 36e5)
      shipMoji = await fetchShipmoji(app);
    return shipMoji;
  };
})();
export const moji = shipMoji;

export const neverShipped404 = (selfCall: boolean, user?: string) => {
  if (selfCall) return "" +
    "looks like you haven't shipped anything yet, " +
    "or your ships haven't received any reactions.\n\n" +
    `post something cool you've made in <#${ids.ship}>, ` +
    "and the scales may yet tip in your favor!";
  else return "" +
    `looks like ${user} hasn't shipped anything yet, ` +
    "or their ships haven't received any reactions.\n\n" +
    `perhaps if they post something cool they've made in <#${ids.ship}>, ` +
    "the scales may yet tip in their favor!";
}

export const shipLink = (shipMsgId: string, text: string) => {
  return "<https://hackclub.slack.com/archives/C0M8PUPU6/p" +
    shipMsgId.replace(".", "") + "|" + text + ">";
};
export const link = shipLink;

export const shipsCmd = async (app: App, respond: RespondFn, _user: string, selfCall: boolean) => {
  const user = ["all", "global", "<!everyone>"].includes(_user) ? null : normUserId(_user);

  /* parse out the shipMoji data we actually need for this query */
  const allmoji = await shipMoji(app);
  const moji = (user == null) ? [...allmoji.values()].flat() : (allmoji.get(user) ?? []);

  /* bail if there's no relevant data */
  if (moji.length == 0)
    return await respond(neverShipped404(selfCall, user!));

  /* ships = number of ships with this moji */
  type MojiVariant = { name: string, ships: number, sum: number };
  const mojiVariants: MojiVariant[] = (() => {
    /* now that we have the most popular emoji on each of their ships, we can do
     * some more data analysis to rank the emoji across all of their ships, and
     * tally up a total # of occurrences while we're at it */
    const map: Map<string, number[]> = moji.reduce(
      (ret, {name, count}) => {
        const variant = ret.get(name) ?? [];
        variant.push(count);
        return ret.set(name, variant);
      },
      new Map()
    );
    /* the map was useful to handle repeats in an O(n) way, but what we really
       want is a list we can sort to make a ranking */
    return [...map.entries()]
      .map(([name, perShip]) => ({ name, ships: perShip.length, sum: sum(perShip) }))
      .sort((a, b) => b.sum - a.sum)
      .sort((a, b) => b.ships - a.ships);
  })();
  const totalMaxReacts = sum(moji.map(r => r.count!));

  /* now to figure out which users most commonly react to your ships */
  const fans: { user: string, ships: number }[] = (() => {
    const map: Map<string, number> = moji.reduce(
      (ret, react) => {
        for (const fan of react.users!)
          ret.set(fan, (ret.get(fan) ?? 0) + 1);
        return ret;
      },
      new Map()
    );
    /* now we can make a ranking */
    return [...map.entries()]
      .map(([user, ships]) => ({ user, ships }))
      .sort((a, b) => b.ships - a.ships);
  })();

  await respond((() => {
    let txt = "";
    txt += `the most popular reactions across all ${moji.length} `
    txt += (user == null ? "" : `of ${user}'s `) + `<#${ids.ship}>s `;
    txt += `*are worth ${totalMaxReacts}*:scales: in total.`;
    for (const {name, sum, ships} of mojiVariants) {
      txt += `\n${sum} :${name}: `;
      if (ships > 1)
        txt += `across ${ships} ships`;
      else
        txt += "on a single ship";

      if (user != null && ships < 5) {
        txt += " (";
        txt += moji
          .filter(x => x.name == name)
          .map(({msg}, i) => shipLink(msg, ships > 1 ? ("" + ++i) : "this one"))
          .join(", ");
        txt += ")";
      }
    }
    if (moji.length > 1) {
      if (user == null)
        txt += "\n*Globally, the top 5 ship reactors are:*";
      else {
        txt += "\n*" + (selfCall ? "Your " : (user + "'s "));
        txt += `top ${Math.min(5, fans.length)} fans are:*`;
      }
      for (const {user, ships} of fans.slice(0, 5)) {
        const ratio = parseFloat((ships/moji.length * 100).toFixed(1));
        /* want to say "has added the most popular reaction to" but too many chars ... */
        txt += `\n<@${user}>, reacted on ${ratio}%`;
      }
    }

    return txt;
  })());
};
