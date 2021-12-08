import { normUserId, isUserId, BadInput, fullIdRegex } from "./utils";
import { token, signingSecret } from "./auth.json";
import { shipsCmd } from "./ships";
import passgo from "./passgo";
import * as account from "./account";
import { App, ExpressReceiver, directMention } from '@slack/bolt';
import { SlackCommandMiddlewareArgs } from "@slack/bolt/dist/types/command";

/* init slack conn */
const receiver = new ExpressReceiver({ signingSecret});
const app = new App({ token: token.bot, receiver });

account.api(app, receiver);

const help = `_:sc: sc, or scalecoin, is a \
<https://github.com/cedric-h/sb|community run> \
currency. collect all the scales to become one with orpheus. :orpheus:_

usage:
\`/sc passgo\` collect funds from your ships. *start here!*
\`/sc bal [USER]\` see how much money \`[USER]\` has. omit \`[USER]\` to see your own.
\`/sc pay USER AMT\` removes \`AMT\` from your account and places it in \`USER\`'s.
\`/sc givefig USER FIG\` like \`sc pay\`, but for figurines. FIG can be an emoji or ping.
\`/sc ships [USER]\` to see a neat compilation of \`[USER]\`'s ship data.
`;

(async () => {
  await app.start(3000);

  app.action('delete_message', async ({ body, ack }) => {
    await ack();
    const { message_ts, channel_id } = (body as any).container;
    await app.client.chat.delete({ channel: channel_id, ts: message_ts });
  });

  app.event(/^app_mention|message$/, async args => {
    const say = args.say;
    if (['user', 'text'].some(x => !args.event.hasOwnProperty(x))) return;
    const { user, text: msgTxt } = args.event as any;

    const match = msgTxt.match(/^<@U02M5Q2JWKF> my puppetmaster is <@([A-Za-z0-9]+)(?:|.+)?>$/);
    if (!match) return void await say("huh?");

    const [owner, bot] = [match[1]!, user!].map(normUserId);
    await say(`o rly? ok i'll dm ${owner} ur token then ;)`);

    const { id, prevOwner } = account.makeApiToken({ owner, bot });
    const text = `${bot}'s token is ${id}` +
      '\n*keep it somewhere safe!*' +
      '\nit allows full programmatic access to all of your sc & figs!' +
      (prevOwner ? `\n(overwriting token previously registered by ${prevOwner})` : '');
    /* channel != owner because api doesn't like the <@x> formatting */
    await app.client.chat.postMessage({ channel: match[1], text, blocks: [{
      'type': 'section',
      'text': { 'type': 'mrkdwn', text },
      'accessory': {
        'type': 'button',
        'text': { 'type': 'plain_text', 'text': 'Delete Message' },
        'action_id': 'delete_message',
        'style': 'danger',
      }
    }]});
  });

  app.command('/sc', forwardErrToUser(async ({ command, ack, respond }) => {
    await ack();

    console.log(`${command.user_id} ran /sc ${command.text}`);

    /* could probably reorganize all this weird input handling stuff as middleware? */
    const [cmd, user = command.user_id, amt] = command.text.trim().split(/\s+/);
    const selfCall = isUserId(user) && normUserId(command.user_id) == normUserId(user);

    switch (cmd) {
      case "ships":
        return await shipsCmd(app, respond, user, selfCall);
      case "passgo": {
        if (command.text.trim().slice("passgo".length) != "")
          throw new BadInput("passgo takes no args.");
        return await passgo(app, respond, normUserId(command.user_id));
      }
      case "bal":
      case "balance":
        return await account.balCmd(app, respond, normUserId(user), selfCall);
      case "figgive":
      case "givefig": {
        const [fromId, toId] = [command.user_id, user].map(normUserId);

        let fig, match;
        if (match = amt.match(/^:(.+):$/))
          fig = { kind: account.FigKind.Emoji, id: match[1] };
        else if (match = amt.match(fullIdRegex))
          fig = { kind: account.FigKind.Hacker, id: match[1] };

        if (!fig) throw new BadInput("Expected emoji or ping, got: " + amt);
        return await account.givefigCmd(app, respond, fromId, toId, fig);
      }
      case "pay": {
        if (amt == undefined)
          throw new BadInput("Desired transaction amount not provided");
        const [fromId, toId] = [command.user_id, user].map(normUserId);
        return await account.payCmd(app, respond, fromId, toId, parseFloat(amt) * 100 + "");
      }
      default:
        return await respond(help);
    }
  }));

  function forwardErrToUser(fn: (args: SlackCommandMiddlewareArgs) => Promise<any>) {
    return async (args: SlackCommandMiddlewareArgs) => {
      try { await fn(args); }
      catch(e) {
        await args.respond(
          (e instanceof BadInput)
            ? ("Bad Input: " + e.message)
            : (console.error(e), "Bot Internals: " + e)
        );
      }
    }
  }

  console.log('⚡️ Bolt app is running!');
})();
