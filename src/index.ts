/// <reference types="@slack/types" />
/// <reference types="@slack/bolt" />
import { token, signingSecret } from "./auth.json";
import { App } from '@slack/bolt';
import { Match } from "@slack/web-api/dist/response/SearchMessagesResponse";

// Initializes your app with your bot token and signing secret
const app = new App({ token: token.bot, signingSecret });

(async () => {
  // Start your app
  await app.start(3000);

  function threadTsFromPermalink(permalink: string) {
    const m = permalink.match(/thread_ts=([0-9.]*)/);
    return m ? m[1] : m;
  }

  // The echo command simply echoes on command
  app.command('/sc', async ({ command, ack, respond }) => {
    // Acknowledge command request
    await ack();

    let ships: Match[] = [];
    let cursor: string = "*";
    while (cursor != "") {
      const res = await app.client.search.messages({
        token: token.user,
        page: 1000,
        cursor,
        query: "in:<#C0M8PUPU6|ship> from:" + command.user_id,
        sort: "timestamp",
        sort_dir: "desc",
      });
      if (!res.ok) await respond("" + res?.error);

      cursor = res.response_metadata!.next_cursor!;

      ships = ships.concat((res.messages!.matches ?? []).filter(m => {
        const threadTs = threadTsFromPermalink(m.permalink!);
        return !threadTs || (threadTs == m.ts);
      }));
    }

    await respond(ships.length + " messages in #ship");
  });

  console.log('⚡️ Bolt app is running!');
})();
