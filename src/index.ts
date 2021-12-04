import { normUserId, isUserId } from "./utils";
import { token, signingSecret } from "./auth.json";
import passgo from "./passgo"
import { bal, send } from "./account"
import { App } from '@slack/bolt';
import { SlackCommandMiddlewareArgs } from "@slack/bolt/dist/types/command";

/* init slack conn */
const app = new App({ token: token.bot, signingSecret });

const help = `:scales: sc, or scalecoin, is a community run currency. usage:
\`/sc passgo [USER]\` collect funds from your ships, or analyze another's.
\`/sc bal [USER]\` see how much money \`[USER]\` has. omit \`[USER]\` to see your own.
\`/sc send USER AMT\` removes \`AMT\` from your account and places it in \`USER\`'s.
`;

(async () => {
  await app.start(3000);

  app.command('/sc', forwardErrToUser(async ({ command, ack, respond }) => {
    await ack();

    console.log(`${command.user_id} ran /sc ${command.text}`);

    const [cmd = "help", user = command.user_id, amt] = command.text.trim().split(/\s+/);
    const selfCall = isUserId(user) && normUserId(command.user_id) == normUserId(user);

    switch (cmd) {
      case "passgo":
        return await passgo(app, respond, user, selfCall);
      case "bal":
      case "balance":
        return await bal(respond, normUserId(user), selfCall);
      case "send":
        if (amt == undefined)
          throw new Error("Desired transaction amount not provided");
        const cents = parseInt("" + (parseFloat(amt) * 100));
        const [fromId, toId] = [command.user_id, user].map(normUserId);
        return await send(respond, fromId, toId, cents);
      default:
        return await respond(help);
    }
  }));

  function forwardErrToUser(fn: (args: SlackCommandMiddlewareArgs) => Promise<any>) {
    return async (args: SlackCommandMiddlewareArgs) => {
      try { await fn(args); }
      catch(e) {
        await args.respond("Bot Internals: " + e);
        console.error("" + e);
      }
    }
  }

  console.log('⚡️ Bolt app is running!');
})();
