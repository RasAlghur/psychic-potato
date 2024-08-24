import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";
import { Metaplex } from "@metaplex-foundation/js";
import pkg from "@metaplex-foundation/mpl-auction-house";
import { Connection, PublicKey } from "@solana/web3.js";
import { ENV, TokenListProvider } from "@solana/spl-token-registry";
dotenv.config();

const { AuthorityScope } = pkg;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Periodically check for all-time high every 60 seconds
const CHECK_INTERVAL = 60000; // 30 secs
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const BOT_IMAGE_URL = process.env.BOT_IMAGE_URL;
const ALERT_CHANNEL_ID = "1275427179617980426";

const EXCLUDED_BOT_ID = [
  "1270155497911095337",
  "1270148826694549505",
  "1270462498562375823",
  "1269735196802940960",
  "1270139028318064691",
  "1270471392571297845",
  "1270475554612838432",
  "1269782311533281281",
];

const MONITORED_CHANNEL_IDS = [
  "1272391061410549854",
  "1268746136269754499",
  "1268746365744447560",
  "1268713939965837453",
  "1268747183046525070",
  "1268714226734727189",
  "1268746243325169674",
  "1268746304205619230",
  "1268746980943990838",
  "1268747528086622219",
  "1268746833698623589",
  "1268746431624380509",
  "1268747260007682068",
  "1268746488327045252",
  "1268746921074229279",
];

const caTracker = {};
const userCallCounts = {}; // To track the number of calls per user
const userPerformance = {};
const tokenState = {}; // To track the last market cap checked for each token
const processedEntries = new Set();

// Function to calculate user performance based on caTracker
function calculateUserPerformance(username) {
  let wins = 0;
  let losses = 0;

  for (const ca in caTracker) {
    caTracker[ca].forEach(entry => {
      if (entry.username === username) {
        if (entry.isWin) {
          wins++;
        } else {
          losses++;
        }
      }
    });
  }

  return { wins, losses };
}

// Function to get user performance
function getUserPerformance(username) {
  const { wins, losses } = calculateUserPerformance(username);

  if (wins + losses > 0) {
    const totalCalls = wins + losses;
    const winrate = (wins / totalCalls) * 100;
    return `User <${username}> has ${wins} wins and ${losses} losses. Winrate: ${winrate.toFixed(2)}%`;
  } else {
    return `No performance data available for user <${username}>.`;
  }
}

// Helper function to format market cap
function formatMarketCap(marketCap) {
  if (marketCap >= 1e9) {
    return (marketCap / 1e9).toFixed(2) + "B";
  } else if (marketCap >= 1e6) {
    return (marketCap / 1e6).toFixed(2) + "M";
  } else if (marketCap >= 1e3) {
    return (marketCap / 1e3).toFixed(2) + "K";
  } else if (marketCap > 0) {
    return marketCap.toFixed(2);
  } else {
    return null;
  }
}

function isValidPublicKey(key) {
  try {
    new PublicKey(key);
    return true;
  } catch (e) {
    return false;
  }
}

async function getTokenPrice(mintAddress) {
  try {
    const response = await fetch(
      `https://api-v3.raydium.io/mint/price?mints=${mintAddress}`,
      { timeout: 10000 }
    ); // 10 seconds timeout
    const responseData = await response.json();

    if (responseData.success && responseData.data) {
      const tokenPrice = responseData.data[mintAddress];
      return tokenPrice ? parseFloat(tokenPrice) : null;
    }
  } catch (error) {
    if (error.code === "UND_ERR_CONNECT_TIMEOUT") {
      console.error("Connection timed out. Please try again later.");
    } else {
      console.error("Error fetching token price:", error);
    }
    return null;
  }

  return null;
}

async function getTokenSupply(connection, mintAddress) {
  const mintInfo = await connection.getParsedAccountInfo(mintAddress);
  if (mintInfo.value && mintInfo.value.data) {
    const supply = mintInfo.value.data.parsed.info.supply;
    return parseFloat(supply) / 10 ** mintInfo.value.data.parsed.info.decimals;
  }

  return null;
}

async function getTokenMetadata(ca) {
  console.log("Fetching token metadata...");
  const connection = new Connection(
    "https://api.mainnet-beta.solana.com",
    "confirmed"
  );
  const metaplex = Metaplex.make(connection);
  const mintAddress = new PublicKey(ca);

  let tokenName = "";
  let tokenSymbol = "";
  let tokenLogo = "";
  let tokenDesc = "";
  let tokenX = "❌";
  let tokenTg = "❌";
  let tokenWeb = "❌";
  let tokenCreationDate = "❌";
  let formattedDate = "❌";
  let marketCap = "";
  let exchangeValue = `[Raydium](https://raydium.io/swap/?outputMint=${mintAddress}&inputMint=sol)`; // Default exchange value

  try {
    const metadataAccount = metaplex
      .nfts()
      .pdas()
      .metadata({ mint: mintAddress });
    const metadataAccountInfo = await connection.getAccountInfo(
      metadataAccount
    );

    if (metadataAccountInfo) {
      const token = await metaplex
        .nfts()
        .findByMint({ mintAddress: mintAddress });
      tokenName = token.name;
      tokenSymbol = token.symbol;
      tokenLogo = token.json?.image;
      tokenDesc = token.json?.description;
      tokenX = token.json?.twitter || "❌";
      tokenTg = token.json?.telegram || "❌";
      tokenWeb = token.json?.website || "❌";

      const tokenPrice = await getTokenPrice(mintAddress.toBase58());
      const tokenSupply = await getTokenSupply(connection, mintAddress);

      if (tokenPrice !== null && tokenSupply !== null) {
        marketCap = tokenPrice * tokenSupply;
      } else {
        console.error("Token Price or Supply: Not available");
      }
    } else {
      const provider = await new TokenListProvider().resolve();
      const tokenList = provider.filterByChainId(ENV.MainnetBeta).getList();
      const tokenMap = tokenList.reduce((map, item) => {
        map.set(item.address, item);
        return map;
      }, new Map());

      const token = tokenMap.get(mintAddress.toBase58());
      if (token) {
        tokenName = token.name;
        tokenSymbol = token.symbol;
        tokenLogo = token.logoURI;
        tokenDesc = token.description || "No description available";
        tokenX = token.twitter || "❌";
        tokenTg = token.telegram || "❌";
        tokenWeb = token.website || "❌";

        const tokenPrice = await getTokenPrice(mintAddress.toBase58());
        const tokenSupply = await getTokenSupply(connection, mintAddress);

        if (tokenPrice !== null && tokenSupply !== null) {
          marketCap = tokenPrice * tokenSupply;
        } else {
          console.error("Token Price or Supply: Not available");
        }
      }
    }
  } catch (error) {
    console.error("Error fetching token metadata:", error);
  }

  const formattedMarketCap = formatMarketCap(marketCap);
  if (!formattedMarketCap) {
    exchangeValue = `[PumpFun](https://pump.fun/${mintAddress})`;
  }

  return {
    tokenName,
    tokenSymbol,
    tokenLogo,
    tokenDesc,
    tokenX,
    tokenTg,
    tokenWeb,
    formattedDate,
    marketCap: formattedMarketCap,
    exchangeValue,
  };
}

client.on("messageCreate", async (message) => {
  if (message.author.id === client.user.id) return;
  if (EXCLUDED_BOT_ID.includes(message.author.id)) return;
  if (!MONITORED_CHANNEL_IDS.includes(message.channel.id)) return;

  const content = message.content;
  // const regex = /[1-9A-HJ-NP-Za-km-z]{44}/g;
  const regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/g;

  const alertChannel = client.channels.cache.get(ALERT_CHANNEL_ID);

  if (!alertChannel) {
    console.error(`Alert channel with ID ${ALERT_CHANNEL_ID} not found.`);
    return;
  }

  if (content.startsWith("!perf")) {
    console.log("!performance command received");
    const username = message.author.username;
    const performanceMessage = getUserPerformance(username);
    alertChannel.send(performanceMessage);
  }

  // if (content.startsWith(`!perf@${username_entry}`)) {
  //   console.log("!performance command received");
  //   const username = username_entry;
  //   const performanceMessage = getUserPerformance(username);
  //   alertChannel.send(performanceMessage);
  // }

  const matches = content.match(regex);
  if (matches) {
    matches.forEach(async (ca) => {
      if (!isValidPublicKey(ca)) {
        console.error(`Invalid public key: ${ca}`);
        return;
      }

      // Check if the token address is already tracked by any user
      if (caTracker[ca]) {
        console.log(
          `Token address ${ca} already tracked by ${caTracker[ca][0].username}. Ignoring further mentions ${caTracker[ca].username}.`
        );
        return;
      }

      // Track the token address if it hasn't been tracked yet
      caTracker[ca] = [
        {
          timestamp: Date.now(),
          messageLink: message.url,
          messageContent: message.content,
          channelId: message.channel.id,
          username: message.author.username,
          userId: message.author.id, // Store the user ID for future use
          isWin: false, // Initialize isWin to false
          roi: null,
        },
      ];
      // Continue with alerting or any other logic
      await checkAndSendAlert(ca);
    });
  }
});

// async function checkAllTimeHighs() {
//   const alertChannel = client.channels.cache.get(ALERT_CHANNEL_ID);

//   if (!alertChannel) {
//     console.error(`Alert channel with ID ${ALERT_CHANNEL_ID} not found.`);
//     return;
//   }

//   Object.keys(caTracker).forEach(async (ca) => {
//     // console.log("the ca tracker", caTracker);
//     console.log(caTracker);
//     const { marketCap, tokenSymbol } = await getTokenMetadata(ca);

//     const isIncomplete = marketCap == null;

//     if (isIncomplete) {
//       console.log(`Incomplete MC data for token ${ca}: ATH is ${marketCap}`);
//       delete caTracker[ca];
//       // continue; // Skip to the next iteration
//     }

//     const username = caTracker[ca][0].username;
//     const userId = caTracker[ca][0].userId; // Retrieve the user ID from caTracker
//     const usernameMention = `<@${userId}>`;
//     const usernameCheck = caTracker[ca].username;
//     console.log("usernameCheck", usernameCheck)

//     // Retrieve the number of calls made by this user
//     const totalCallsByUser = userCallCounts[username] || 0;

//     // Store the market cap at the time of the call if it doesn't exist
//     if (!caTracker[ca].initialMarketCap) {
//       caTracker[ca].initialMarketCap = marketCap;
//     }

//     // Initialize allTimeHigh with the initial market cap if not already set
//     if (!caTracker[ca].allTimeHigh) {
//       caTracker[ca].allTimeHigh = caTracker[ca].initialMarketCap;
//     }

//     const initialMarketCap = caTracker[ca].initialMarketCap;

//     if(!caTracker[ca].roi) {
//       // ((ATH - initialMC) / initalMC) * 100
//       caTracker[ca].roi = ((caTracker[ca].allTimeHigh - caTracker[ca].initialMarketCap) / caTracker[ca].initialMarketCap) * 100;
//     }

//     console.log(`caTracker[ca].roi for ${tokenSymbol}: ${caTracker[ca].roi}%`);
//     console.log(`${tokenSymbol} ${caTracker[ca].allTimeHigh}`);

//     // Update ATH before checking if new ATH is reached
//     // updateATH(ca, username);

//     if (
//       marketCap > caTracker[ca].allTimeHigh &&
//       marketCap > initialMarketCap
//     ) {
//       caTracker[ca].allTimeHigh = marketCap;
//       console.log(
//         `${marketCap} MC did pass ATH of ${caTracker[ca].allTimeHigh}`
//       );

//       caTracker[ca][0].isWin = true;
//       const embed = new EmbedBuilder()
//         .setColor(0xff0000)
//         .setTitle(
//           `${tokenSymbol} just reached a marketCap of ${marketCap}, new all-time high!`
//         )
//         .setThumbnail(BOT_IMAGE_URL)
//         .addFields(
//           {
//             name: "Caller Profile",
//             value: `${username} (Total Calls: ${totalCallsByUser})`,
//             inline: true,
//           },
//           {
//             name: "Called at",
//             value: initialMarketCap.toString() || "NA",
//             inline: true,
//           },
//           {
//             name: "ATH MCAP",
//             value: caTracker[ca].allTimeHigh.toString() || "NA",
//             inline: true,
//           }
//         )
//         .setTimestamp();

//       alertChannel.send({ embeds: [embed] });
//     } else {
//       console.log(
//         `${marketCap} MC did not pass ATH of ${caTracker[ca].allTimeHigh}`
//       );
//     }
//     console.log("-------------------------------")
//   });
//   return;
// }

async function checkAllTimeHighs() {
  const alertChannel = client.channels.cache.get(ALERT_CHANNEL_ID);

  if (!alertChannel) {
    console.error(`Alert channel with ID ${ALERT_CHANNEL_ID} not found.`);
    return;
  }

  for (const ca of Object.keys(caTracker)) {
    const { marketCap, tokenSymbol } = await getTokenMetadata(ca);

    if (marketCap == null) {
      console.log(`Incomplete MC data for token ${ca}: ATH is ${marketCap}`);
      delete caTracker[ca];
      continue; // Skip to the next iteration
    }

    const username = caTracker[ca][0].username;
    const userId = caTracker[ca][0].userId; // Retrieve the user ID from caTracker
    const usernameMention = `<@${userId}>`;

    // Retrieve the number of calls made by this user
    const totalCallsByUser = userCallCounts[username] || 0;

    // Store the market cap at the time of the call if it doesn't exist
    if (!caTracker[ca].initialMarketCap) {
      caTracker[ca].initialMarketCap = marketCap;
    }

    // Initialize allTimeHigh with the initial market cap if not already set
    if (!caTracker[ca].allTimeHigh) {
      caTracker[ca].allTimeHigh = caTracker[ca].initialMarketCap;
    }

    const initialMarketCap = caTracker[ca].initialMarketCap;

    // Calculate ROI whenever the market cap changes
    if (marketCap > caTracker[ca].allTimeHigh && marketCap > initialMarketCap) {
      caTracker[ca].allTimeHigh = marketCap;
      caTracker[ca][0].isWin = true;

      // Update ROI calculation after setting new ATH
      caTracker[ca][0].roi = ((caTracker[ca].allTimeHigh - initialMarketCap) / initialMarketCap) * 100;

      console.log(`caTracker[ca].roi for ${tokenSymbol}: ${caTracker[ca][0].roi}%`);

      const embed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle(
          `${tokenSymbol} just reached a marketCap of ${marketCap}, new all-time high!`
        )
        .setThumbnail(BOT_IMAGE_URL)
        .addFields(
          {
            name: "Caller Profile",
            value: `${usernameMention} (Total Calls: ${totalCallsByUser})`,
            inline: true,
          },
          {
            name: "Called at",
            value: initialMarketCap.toString() || "NA",
            inline: true,
          },
          {
            name: "ATH MCAP",
            value: caTracker[ca].allTimeHigh.toString() || "NA",
            inline: true,
          }
        )
        .setTimestamp();

      alertChannel.send({ embeds: [embed] });
    } else {
      console.log(
        `${marketCap} MC did not pass ATH of ${caTracker[ca].allTimeHigh}`
      );
    }
    console.log("-------------------------------")
  }
}

async function checkAndSendAlert(ca) {
  const alertChannel = client.channels.cache.get(ALERT_CHANNEL_ID);

  if (!alertChannel) {
    console.error(`Alert channel with ID ${ALERT_CHANNEL_ID} not found.`);
    return;
  }

  const { tokenName, tokenSymbol, tokenLogo, marketCap, exchangeValue } =
    await getTokenMetadata(ca);

  const isIncomplete = !tokenName || !tokenSymbol || marketCap == null;

  if (isIncomplete) {
    console.log(`Incomplete data for token ${ca}: marketCap is ${marketCap}`);
    delete caTracker[ca];
    return; // Exit early if data is incomplete
  } else {
    const channelMentions = caTracker[ca].reduce((acc, entry) => {
      if (!acc[entry.channelId]) {
        acc[entry.channelId] = { count: 0, messages: [] };
      }
      acc[entry.channelId].count++;
      acc[entry.channelId].messages.push(
        `[Message tracked at <t:${Math.floor(entry.timestamp / 1000)}:T>](${entry.messageLink
        }) by ${entry.username}`
      );
      return acc;
    }, {});

    const username = caTracker[ca][0].username;
    const userId = caTracker[ca][0].userId; // Retrieve the user ID from caTracker
    const usernameMention = `<@${userId}>`;

    // Increment the user's call count
    if (!userCallCounts[username]) {
      userCallCounts[username] = 0;
    }
    userCallCounts[username] += 1;

    console.log(`${username} has made ${userCallCounts[username]} token calls`);

    // if (!userCallCounts[message.author.id]) {
    //     userCallCounts[message.author.id] = 0;
    // }
    // userCallCounts[message.author.id] += 1;

    // console.log(`${message.author.username} has made ${userCallCounts[message.author.id]} token calls`);

    // Retrieve the number of calls made by this user
    const totalCallsByUser = userCallCounts[username] || 0;

    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle(`${username} called ${tokenSymbol} at $${marketCap}`)
      .setThumbnail(tokenLogo || BOT_IMAGE_URL)
      .addFields(
        {
          name: "Caller Profile",
          value: `${username} (Total Calls: ${totalCallsByUser})`,
          inline: true,
        },
        {
          name: "Dex",
          value: `[Dexscreener](https://dexscreener.com/search?q=${ca})`,
          inline: true,
        },
        { name: "Token Address / CA", value: `\`${ca}\``, inline: false },
        { name: "MCAP", value: marketCap.toString() || "NA", inline: true },
        { name: "EXCHANGE", value: exchangeValue, inline: true }
      )
      .setTimestamp();

    for (const [channelId, details] of Object.entries(channelMentions)) {
      const channel = client.channels.cache.get(channelId);
      const channelName = channel ? channel.name : "Unknown Channel";
      embed.addFields({
        name: `${channelName} called ${details.count} times`,
        value: details.messages.join("\n"),
        inline: false,
      });
    }

    alertChannel.send({ embeds: [embed] });
  }
}

client.once("ready", () => {
  console.log("Bot is online!");
  setInterval(checkAllTimeHighs, CHECK_INTERVAL);
});

client.login(BOT_TOKEN);
