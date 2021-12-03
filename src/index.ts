import { token, signingSecret } from "./auth.json";
import { App } from '@slack/bolt';
import { Reaction } from "@slack/web-api/dist/response/ConversationsHistoryResponse";
import { SlackCommandMiddlewareArgs } from "@slack/bolt/dist/types/command";
// import * as fs from "fs";
import fs from "fs";

/* init slack conn */
const app = new App({ token: token.bot, signingSecret });
const ids = { ship: "C0M8PUPU6" };

/* handy lil utils */
const sum = (arr: number[]) => arr.reduce((a, x) => a + x);
const normUserId = (id: string) => {
  const match = id.match(/^<@([a-zA-Z0-9]+)(?:\|.+)?>$/);
  if (match && match.length >= 2)
    return `<@${match[1]}>`;
  if (/^[a-zA-Z0-9]+$/.test(id))
    return `<@${id}>`;
  throw new Error("couldn't normalize user id: " + id);
}
const serialize = (x: any) => JSON.stringify(x, (_, v) => {
  if (v.__proto__ == Map.prototype)
    return { "__prototype__": "Map", "data": Object.fromEntries(v.entries()) };
  return v;
});
const deserialize = (x: string) => JSON.parse(x, (_, v) => {
  if (v.__prototype__ == "Map")
    return new Map(Object.entries(v.data));
  return v;
});
function forwardErrToUser(fn: (args: SlackCommandMiddlewareArgs) => Promise<any>) {
  return async (args: SlackCommandMiddlewareArgs) => {
    try { await fn(args); }
    catch(e) {
      await args.respond("Bot Internals: " + e);
      console.error("" + e);
    }
  }
}

/* we're taking reactions out of the context of their original message,
 * so there's some of that context that we need to save */
type React = Reaction & { msg: string };

/* gives you a cached shipmoji if it's still pipin' hot, otherwise buckle in because
 * we're fetching a new one for ya!
 * 
 * the #1 goal is to return relevant info, the #2 goal is to not refresh unless there
 * is a need to do so. */
const shipmoji: (() => Promise<Map<string, React[]>>) = (() => {
  let shipmoji: Map<string, React[]>,
      lastCache: number;

  const file = "../shipmojiCache.json";
  try {
    ({ lastCache, shipmoji } = deserialize(fs.readFileSync(file, "utf-8")));
  } catch(e) {
    console.log("couldn't find " + file + ": " + e);
  }

  const fetchShipmoji = async () => {
    console.log("fetching shipmoji ...");

    shipmoji = new Map();
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
        const userShipmoji = shipmoji.get(user) ?? [];

        /* push only the most popular reaction */
        const reacts = msg.reactions.reduce((a, x) => (x.count! > a.count!) ? x : a);
        userShipmoji.push(Object.assign(reacts, { msg: msg.ts! }));

        shipmoji.set(user, userShipmoji);
      }
    }

    fs.writeFileSync(file, serialize({ lastCache, shipmoji }), "utf-8");

    return shipmoji;
  };

  return async () => {
    if (shipmoji == undefined || (Date.now() - lastCache) > 36e5)
      shipmoji = await fetchShipmoji();
    return shipmoji;
  };
})();

(async () => {
  await app.start(3000);

  app.command('/sc', forwardErrToUser(async ({ command, ack, respond }) => {
    await ack();

    const user = (command.text == "<!everyone>") ? null : normUserId(
      (command.text.length > 0) ? command.text.trim() : command.user_id
    );
    const selfCall = command.text == "" || normUserId(command.user_id) == user;

    /* parse out the shipmoji data we actually need for this query */
    const allmoji = await shipmoji();
    const moji = (user == null) ? [...allmoji.values()].flat() : (allmoji.get(user) ?? []);

    /* bail if there's no relevant data */
    if (moji.length == 0)
      if (selfCall)
        return await respond(
          "looks like you haven't shipped anything yet, " +
          "or your ships haven't received any reactions.\n\n" +
          `post something cool you've made in <#${ids.ship}>, ` +
          "and the scales may yet tip in your favor!"
        );
      else
        return await respond(
          `looks like ${user} hasn't shipped anything yet, ` +
          "or their ships haven't received any reactions.\n\n" +
          `perhaps if they post something cool they've made in <#${ids.ship}>, ` +
          "the scales may yet tip in their favor!"
        );

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
            .map(({msg}, i) => {
              return "<https://hackclub.slack.com/archives/C0M8PUPU6/p" +
                     msg.replace(".", "") + "|" + (ships > 1 ? i+1 : "this one") + ">";
            })
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
          txt += `\n<@${user}> reacted on ${ratio}%`;
        }
      }

      console.log(txt);
      return txt;
    })());
  }));
  console.log('⚡️ Bolt app is running!');
})();
