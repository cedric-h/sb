import { token, signingSecret } from "./auth.json";
import { App } from '@slack/bolt';
import { Reaction } from "@slack/web-api/dist/response/ConversationsHistoryResponse";

// Initializes your app with your bot token and signing secret
const app = new App({ token: token.bot, signingSecret });
const ids = { ship: "C0M8PUPU6" };

const sum = (arr: number[]) => arr.reduce((a, x) => a + x);

/* normalizes an ID */
function isUserId(id: string) { return !!id.match(/^<@([a-zA-Z0-9]+)(?:\|[A-Za-z]+)?>$/); }

(async () => {
  // Start your app
  await app.start(3000);

  app.command('/sc', async ({ command, ack, respond }) => {
    await ack();

    console.log(command.text);
    const user = (command.text.length > 0) ? command.text : `<@${command.user_id}>`;
    if (!isUserId(user)) return await respond(`Expected user id, not ${user}!`);

    const shipmoji: Reaction[] = [];
    for (let res, cursor; !res || res.has_more; cursor = res.response_metadata!.next_cursor!) {
      console.log(cursor);
      res = await app.client.conversations.history({
        channel: ids.ship,
        limit: 1000,
        cursor,
      });
      if (!res.ok) return await respond("" + res.error);

      for (const msg of res.messages!)
        if (msg.reactions && msg.reactions.length > 0)
          shipmoji.push(msg.reactions.reduce((a, x) => (x.count! > a.count!) ? x : a));
    }

    if (shipmoji.length == 0)
      return await respond(
        "looks like you haven't shipped anything yet, " +
        "or your ships haven't received any reactions.\n\n" +
        `post something cool you've made in ${ids.ship},` +
        "and the scales may yet tip in your favor!"
      );

    /* ships = number of ships with this moji */
    type MojiVariant = { name: string, ships: number, sum: number };
    const mojivariants: MojiVariant[] = (() => {
      const map: Map<string, number[]> = shipmoji.reduce(
        (ret, {name, count}) => {
          if (ret.has(name))
            ret.get(name).push(count);
          else
            ret.set(name, [count]);
          return ret;
        },
        new Map()
      );
      const ret = [...map.entries()].map(([name, perShip]) => {
        return { name, ships: perShip.length, sum: sum(perShip) };
      });
      //ret.sort((a, b) => b.sum - a.sum);
      ret.sort((a, b) => b.ships - a.ships);
      return ret;
    })();
    const totalMaxReacts = sum(shipmoji.map(r => r.count!));

    await respond((() => {
      // let txt = `<@${user}> has received ${totalMaxReacts} from`;
      let txt = `y'all have received ${totalMaxReacts} most popular reactions from`;
      txt += ` across ${shipmoji.length} <#${ids.ship}>s`;
      for (const {name, sum, ships} of mojivariants)
        txt += `\n:${name}: ${sum} across ${ships} ships`;
      console.log(txt);
      return txt;
    })());
  });
  console.log('⚡️ Bolt app is running!');
})();
