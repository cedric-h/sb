import { normUserId, isUserId, BadInput } from "./utils";
import { token, signingSecret } from "./auth.json";
import { shipsCmd } from "./ships"
import passgo from "./passgo"
import { goblinstompCmd, balCmd, sendCmd } from "./account"
import { App } from '@slack/bolt';
import { SlackCommandMiddlewareArgs } from "@slack/bolt/dist/types/command";

/* init slack conn */
const app = new App({ token: token.bot, signingSecret });

const help = `_:sc: sc, or scalecoin, is a \
<https://github.com/cedric-h/sb|community run> \
currency. collect all the scales to become one with orpheus. :orpheus:_

usage:
\`/sc passgo\` collect funds from your ships. *start here!*
\`/sc bal [USER]\` see how much money \`[USER]\` has. omit \`[USER]\` to see your own.
\`/sc send USER AMT\` removes \`AMT\` from your account and places it in \`USER\`'s.
\`/sc ships [USER]\` to see a neat compilation of \`[USER]\`'s ship data.
`;

(async () => {
  await app.start(3000);

  app.command('/sc', forwardErrToUser(async ({ command, ack, respond }) => {
    await ack();

    console.log(`${command.user_id} ran /sc ${command.text}`);

    /* could probably reorganize all this weird input handling stuff as middleware? */
    const [cmd, user = command.user_id, amt] = command.text.trim().split(/\s+/);
    const selfCall = isUserId(user) && normUserId(command.user_id) == normUserId(user);

    switch (cmd) {
      case "ships":
        return await shipsCmd(app, respond, user, selfCall);
      case "passgo":
        // if (command.text.trim().slice("passgo".length) != "")
        //   throw new BadInput("passgo takes no args.");
        // return await passgo(app, respond, normUserId(command.user_id));
        return await passgo(app, respond, normUserId(user));
      case "goblinstomp":
        // if (command.text.trim().slice("passgo".length) != "")
        //   throw new BadInput("goblinstomp takes no args.");
        // return await goblinstomp(respond, normUserId(command.user_id));
        return await goblinstompCmd(respond, normUserId(user));
      case "bal":
      case "balance":
        return await balCmd(respond, normUserId(user), selfCall);
      case "send":
        if (amt == undefined)
          throw new BadInput("Desired transaction amount not provided");
        const cents = parseInt("" + (parseFloat(amt) * 100));
        const [fromId, toId] = [command.user_id, user].map(normUserId);
        return await sendCmd(respond, fromId, toId, cents);
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
