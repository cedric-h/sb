import { normUserId, isUserId } from "./utils";
import { token, signingSecret } from "./auth.json";
import passgo from "./passgo"
import { App } from '@slack/bolt';
import { SlackCommandMiddlewareArgs } from "@slack/bolt/dist/types/command";

/* init slack conn */
const app = new App({ token: token.bot, signingSecret });

const help = `:scales: sc, or scalecoin, is a community run currency. usage:
\`/sc passgo [USER]\` collect funds from your ships, or analyze another's.
\`/sc bal [USER]\` see how much money \`[USER]\` has. omit \`[USER]\` to see your own.
\`/sc send USER\` removes funds from your account and places them in \`USER\`'s.
`;

(async () => {
  await app.start(3000);

  app.command('/sc', forwardErrToUser(async ({ command, ack, respond }) => {
    await ack();

    const [cmd = "help", user = command.user_id] = command.text.trim().split(/\s+/);
    const selfCall = isUserId(user) && normUserId(command.user_id) == normUserId(user);

    if (cmd == "passgo")
      return await passgo(app, respond, user, selfCall);

    return await respond(help);
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
