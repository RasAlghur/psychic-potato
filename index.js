import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";
import { Metaplex, token } from "@metaplex-foundation/js";
import pkg from "@metaplex-foundation/mpl-auction-house";
import { Connection, PublicKey } from "@solana/web3.js";
import { ENV, TokenListProvider } from "@solana/spl-token-registry";
import fs from 'fs';

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
const CHECK_INTERVAL = 60000; // 60 secs
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

// const caTracker = {};
// Load the caTracker data from the file

let caTracker = loadCaTrackerFromFile();
const userCallCounts = {}; // To track the number of calls per user

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

function transformValue(value) {
  if (typeof value === "string" && value.trim() !== "") {
    const trimmedValue = value.trim();
    const lastChar = trimmedValue.slice(-1).toUpperCase();
    const numericPart = parseFloat(trimmedValue.slice(0, -1).replace(",", ""));

    if (["K", "M", "B"].includes(lastChar)) {
      switch (lastChar) {
        case "K":
          return numericPart * 1e3;
        case "M":
          return numericPart * 1e6;
        case "B":
          return numericPart * 1e9;
      }
    }
  }
  return null;
}

function isValidPublicKey(key) {
  try {
    new PublicKey(key);
    return true;
  } catch (e) {
    return false;
  }
}

async function getTokenPrice(mintAddress, retries = 3, delay = 2000) {
  let attempt = 0;

  while (attempt < retries) {
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
        console.error(`Connection timed out on attempt ${attempt + 1}. Retrying...`);
      } else {
        console.error("Error fetching token price:", error);
      }

      attempt++;

      if (attempt < retries) {
        await new Promise(res => setTimeout(res, delay)); // Delay before retrying
      }
    }
  }

  console.error(`Failed to fetch token price after ${retries} attempts.`);
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

function getEmojiForWinRate(winRate) {
  if (winRate >= 80) {
    return "🏆"; // Trophy emoji for very high win rates
  } else if (winRate >= 60) {
    return "🥇"; // Gold medal emoji for high win rates
  } else if (winRate >= 40) {
    return "🥈"; // Silver medal emoji for medium win rates
  } else if (winRate >= 20) {
    return "🥉"; // Bronze medal emoji for lower win rates
  } else {
    return "❌"; // Cross emoji for very low win rates
  }
}

function getEmojiForRoi(roi) {
  if (roi >= 50) {
    return "🚀"; // Rocket emoji for very high ROI
  } else if (roi >= 20) {
    return "📈"; // Chart emoji for good ROI
  } else if (roi >= 0) {
    return "📊"; // Bar chart emoji for positive ROI
  } else {
    return "📉"; // Downward trend emoji for negative ROI
  }
}

async function getTokenMetadata(ca, retries = 3, delay = 2000) {
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

  let attempt = 0;

  while (attempt < retries) {
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
        break; // Break the loop if successful
      } else {
        console.warn(`Metadata is null on attempt ${attempt + 1}. Retrying...`);
      }
    } catch (error) {
      console.error(`Error fetching token metadata on attempt ${attempt + 1}:`, error);
    }

    attempt++;

    if (attempt < retries) {
      await new Promise(res => setTimeout(res, delay)); // Delay before retrying
    }
  }

  if (attempt === retries) {
    console.error(`Failed to fetch token metadata after ${retries} attempts.`);
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

async function checkAllTimeHighs() {
  const alertChannel = client.channels.cache.get(ALERT_CHANNEL_ID);

  if (!alertChannel) {
    console.error(`Alert channel with ID ${ALERT_CHANNEL_ID} not found.`);
    return;
  }

  for (const ca of Object.keys(caTracker)) {
    const { marketCap } = await getTokenMetadata(ca);

    if (marketCap == null) {
      console.log(`Incomplete MC data for token ${ca}: ATH is ${marketCap}`);
      delete caTracker[ca];
      continue; // Skip to the next iteration
    }

    const username = caTracker[ca][0].username;
    const userId = caTracker[ca][0].userId; // Retrieve the user ID from caTracker
    const usernameMention = `<@${userId}>`;
    const tokenSymbol = caTracker[ca][0].tokenSymbol;

    // Store the market cap at the time of the call if it doesn't exist
    if (!caTracker[ca].initialMarketCap) {
      caTracker[ca].initialMarketCap = marketCap;
      saveCaTrackerToFile()
    }

    // Initialize allTimeHigh with the initial market cap if not already set
    if (!caTracker[ca].allTimeHigh) {
      caTracker[ca].allTimeHigh = caTracker[ca].initialMarketCap;
      saveCaTrackerToFile()
    }

    const initialMarketCap = caTracker[ca].initialMarketCap;

    // Calculate ROI whenever the market cap changes
    if (marketCap > caTracker[ca].allTimeHigh && marketCap > initialMarketCap) {
      caTracker[ca].allTimeHigh = marketCap;
      caTracker[ca][0].isWin = true;

      // Update ROI calculation after setting new ATH
      const allTimeHighRoi = transformValue(caTracker[ca].allTimeHigh);
      const initialMarketCapRoi = transformValue(initialMarketCap);
      const newRoi =
        ((allTimeHighRoi - initialMarketCapRoi) / initialMarketCapRoi) * 100;
      caTracker[ca][0].roi = newRoi.toFixed(2);

      //   console.log(
      //     `caTracker[ca].roi for ${tokenSymbol}: ${caTracker[ca][0].roi}%`
      //   );

      //   const embed = new EmbedBuilder()
      //     .setColor(0xff0000)
      //     .setTitle(
      //       `${tokenSymbol} just reached a marketCap of ${marketCap}, new all-time high!`
      //     )
      //     .setThumbnail(BOT_IMAGE_URL)
      //     .addFields(
      //       {
      //         name: "Caller Profile",
      //         value: `${usernameMention}`,
      //         inline: true,
      //       },
      //       {
      //         name: "Called at",
      //         value: initialMarketCap.toString() || "NA",
      //         inline: true,
      //       },
      //       {
      //         name: "ATH MCAP",
      //         value: caTracker[ca].allTimeHigh.toString() || "NA",
      //         inline: true,
      //       }
      //     )
      //     .setTimestamp();

      //   alertChannel.send({ embeds: [embed] });
      //   // saveCaTrackerToFile();
      // } else {
      //   console.log(
      //     `${tokenSymbol} of ${marketCap} MC did not pass ATH of ${caTracker[ca].allTimeHigh}`
      //   );
    }
    saveCaTrackerToFile();
    // console.log("-------------------------------");
  }
}

function saveCaTrackerToFile() {
  try {
    const data = JSON.stringify(caTracker, null, 2);
    fs.writeFileSync('caTracker.json', data);
  } catch (error) {
    console.error('Error saving caTracker to file:', error);
  }
}

function loadCaTrackerFromFile() {
  try {
    if (fs.existsSync('caTracker.json')) {
      const data = fs.readFileSync('caTracker.json');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading caTracker from file:', error);
  }
  return {}; // Return an empty object if the file doesn't exist or there's an error
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

  caTracker[ca][0].tokenName = tokenName;
  caTracker[ca][0].tokenSymbol = tokenSymbol;

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

    const embed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle(`${username} called ${tokenSymbol} at $${marketCap}`)
      .setThumbnail(tokenLogo || BOT_IMAGE_URL)
      .addFields(
        {
          name: "Caller Profile",
          value: `${username}`,
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
    saveCaTrackerToFile();
    alertChannel.send({ embeds: [embed] });
  }
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

    const embed = new EmbedBuilder()
      .setTitle("User Information")
      .setColor("#3498db")
      .setDescription("Here are your details:")
      .setFooter({
        text: `Requested by ${message.author.username}`,
        iconURL: message.author.displayAvatarURL(),
      });

    const username = message.author.username;
    let roiDetails = [];
    let callDetails = [];
    let groupDetails = new Set(); // Using a Set to avoid duplicate channels
    let totalRoiSum = 0; // To sum up all ROIs
    let totalRoiCount = 0; // To count all valid ROIs
    let wins = 0;
    let losses = 0;

    for (const ca in caTracker) {
      if (caTracker[ca][0].username === username) {
        const tokenSymbol = caTracker[ca][0].tokenSymbol || "Unknown";
        const roi = caTracker[ca][0].roi !== null ? parseFloat(caTracker[ca][0].roi) : 0;
        const timestamp = caTracker[ca][0].timestamp;
        const channelId = caTracker[ca][0].channelId;
        const isWin = caTracker[ca][0].isWin;

        if (isWin) wins++;
        else losses++;

        // Only push if ROI is a number
        roiDetails.push({ tokenSymbol, roi });
        totalRoiSum += roi; // Add ROI to total sum
        totalRoiCount++; // Increment count of valid ROIs

        // Add tokenSymbol and timestamp to callDetails
        callDetails.push({ tokenSymbol, roi, timestamp });

        // Collect unique channel IDs
        groupDetails.add(channelId);
      }
    }

    // Calculate average ROI if there are any valid ROIs
    const averageRoi = totalRoiCount > 0 ? (totalRoiSum / totalRoiCount).toFixed(2) : "0";
    // Calculate win rate
    const winRate = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(2) : "0";

    // Format the call details and group details
    callDetails.sort((a, b) => b.timestamp - a.timestamp);
    const lastThreeCalls = callDetails.slice(0, 3);

    // Format the last three call details into strings
    const formattedCallDetails = lastThreeCalls.map(
      ({ tokenSymbol, roi }, index) =>
        `${index + 1}. ${tokenSymbol} \`${roi}%\``
    );

    // Sort roiDetails by ROI in descending order and format into strings
    roiDetails.sort((a, b) => b.roi - a.roi);
    const formattedRoiDetails = roiDetails.map(
      ({ tokenSymbol, roi }, index) =>
        `${index + 1}. ${tokenSymbol} \`${roi}%\``
    );

    const formattedGroupDetails = [...groupDetails]
      .map((channelId) => {
        const channel = client.channels.cache.get(channelId);
        return channel
          ? `• ${channel.name} (${channelId})`
          : `• Unknown Channel (${channelId})`;
      })
      .join("\n");

    // Add user performance summary to embed
    embed.addFields(
      {
        name: `**${username}**`,
        value: `Winrate: \`${winRate}%\` ${getEmojiForWinRate(winRate)} | Avg ROI: \`${averageRoi}%\` ${getEmojiForRoi(averageRoi)}\n` +
          `Wins: \`${wins}\` | Losses: \`${losses}\` | Total Calls: \`${wins + losses}\``,
        inline: false,
      },
      { name: '**Tokens Called and ROIs**', value: formattedRoiDetails.join("\n") || "None", inline: true },
      { name: '**Most Recent Calls**', value: formattedCallDetails.join("\n") || "None", inline: true },
      { name: '**Groups**', value: formattedGroupDetails || "None", inline: true }
    );

    // Send the embed to the alert channel
    alertChannel.send({ embeds: [embed] });
  }

  if (content.startsWith("!info")) {
    const users = message.mentions.users;

    if (users.size > 0) {
      // Create a new embed
      const embed = new EmbedBuilder()
        .setTitle("User Information")
        .setColor("#3498db")
        .setDescription("Here are the details of the mentioned users:")
        .setFooter({
          text: `Requested by ${message.author.username}`,
          iconURL: message.author.displayAvatarURL(),
        });

      // Iterate through each mentioned user
      users.forEach((user) => {
        const username = user.username;
        console.log(`!info command received from ${username}`);

        // Collect all token symbols and ROIs for the user
        let roiDetails = [];
        let callDetails = [];
        let groupDetails = new Set(); // Using a Set to avoid duplicate channels
        let totalRoiSum = 0; // To sum up all ROIs
        let totalRoiCount = 0; // To count all valid ROIs
        let wins = 0;
        let losses = 0;

        for (const ca in caTracker) {
          if (caTracker[ca][0].username === username) {
            const tokenSymbol = caTracker[ca][0].tokenSymbol || "Unknown";
            const roi =
              caTracker[ca][0].roi !== null
                ? parseFloat(caTracker[ca][0].roi)
                : 0;
            const timestamp = caTracker[ca][0].timestamp;
            const channelId = caTracker[ca][0].channelId;
            const isWin = caTracker[ca][0].isWin;

            if (isWin) wins++;
            else losses++;

            // Only push if ROI is a number
            roiDetails.push({ tokenSymbol, roi });
            totalRoiSum += roi; // Add ROI to total sum
            totalRoiCount++; // Increment count of valid ROIs

            // Add tokenSymbol and timestamp to callDetails
            callDetails.push({ tokenSymbol, roi, timestamp });

            // Collect unique channel IDs
            groupDetails.add(channelId);
          }
        }

        // Calculate average ROI if there are any valid ROIs
        const averageRoi = totalRoiCount > 0 ? (totalRoiSum / totalRoiCount).toFixed(2) : "0";
        // Calculate win rate
        const winRate = wins + losses > 0 ? ((wins / (wins + losses)) * 100).toFixed(2) : "0";

        // Format the call details and group details
        callDetails.sort((a, b) => b.timestamp - a.timestamp);
        const lastThreeCalls = callDetails.slice(0, 3);

        // Format the last three call details into strings
        const formattedCallDetails = lastThreeCalls.map(
          ({ tokenSymbol, roi }, index) =>
            `${index + 1}. ${tokenSymbol} \`${roi}%\``
        );

        // Sort roiDetails by ROI in descending order and format into strings
        roiDetails.sort((a, b) => b.roi - a.roi);
        const formattedRoiDetails = roiDetails.map(
          ({ tokenSymbol, roi }, index) =>
            `${index + 1}. ${tokenSymbol} \`${roi}%\``
        );

        const formattedGroupDetails = [...groupDetails]
          .map((channelId) => {
            const channel = client.channels.cache.get(channelId);
            return channel
              ? `• ${channel.name} (${channelId})`
              : `• Unknown Channel (${channelId})`;
          })
          .join("\n");

        // Add user performance summary to embed
        embed.addFields(
          {
            name: `**${username}**`,
            value: `Winrate: \`${winRate}%\` ${getEmojiForWinRate(winRate)} | Avg ROI: \`${averageRoi}%\` ${getEmojiForRoi(averageRoi)}\n` +
              `Wins: \`${wins}\` | Losses: \`${losses}\` | Total Calls: \`${wins + losses}\``,
            inline: false,
          },
          { name: '**Tokens Called and ROIs**', value: formattedRoiDetails.join("\n") || "None", inline: true },
          { name: '**Most Recent Calls**', value: formattedCallDetails.join("\n") || "None", inline: true },
          { name: '**Groups**', value: formattedGroupDetails || "None", inline: true }
        );
      });

      // Send the embed to the alert channel
      alertChannel.send({ embeds: [embed] });
    } else {
      message.channel.send("No users mentioned.");
    }
  }

  if (content.startsWith("!top")) {
    // Create a new embed
    const embed = new EmbedBuilder()
      .setTitle("User Information")
      .setColor("#3498db")
      .setDescription("Here are the details of all users in caTracker, ranked by win rate:")
      .setFooter({
        text: `Requested by ${message.author.username}`,
        iconURL: message.author.displayAvatarURL(),
      });

    // Extract and sort users by win rate
    const userPerformance = {};

    for (const ca in caTracker) {
      const username = caTracker[ca][0].username;
      if (!userPerformance[username]) {
        userPerformance[username] = {
          wins: 0,
          losses: 0,
          roiSum: 0,
          roiCount: 0,
          callDetails: [],
          roiDetails: [],
          groupDetails: new Set(),
        };
      }

      const entry = caTracker[ca][0];
      if (entry.isWin) userPerformance[username].wins++;
      else userPerformance[username].losses++;

      if (entry.roi !== null) {
        userPerformance[username].roiSum += parseFloat(entry.roi);
        userPerformance[username].roiCount++;
      }

      userPerformance[username].callDetails.push({
        tokenSymbol: entry.tokenSymbol || "Unknown",
        roi: entry.roi || "0",
        timestamp: entry.timestamp,
      });

      userPerformance[username].roiDetails.push({
        tokenSymbol: entry.tokenSymbol || "Unknown",
        roi: entry.roi || "0",
        timestamp: entry.timestamp,
      });

      userPerformance[username].groupDetails.add(entry.channelId);
    }

    // Convert userPerformance object to an array and sort by win rate
    const sortedUsers = Object.entries(userPerformance).sort(([, a], [, b]) => {
      const winRateA = a.wins + a.losses > 0 ? (a.wins / (a.wins + a.losses)) * 100 : 0;
      const winRateB = b.wins + b.losses > 0 ? (b.wins / (b.wins + b.losses)) * 100 : 0;
      return winRateB - winRateA;
    });

    sortedUsers.forEach(([username, data], index) => {
      const winRate = data.wins + data.losses > 0 ? ((data.wins / (data.wins + data.losses)) * 100).toFixed(2) : 0;
      const avgRoi = data.roiCount > 0 ? (data.roiSum / data.roiCount).toFixed(2) : "0";

      // Format the call details and group details
      data.callDetails.sort((a, b) => b.timestamp - a.timestamp);
      data.roiDetails.sort((a, b) => b.roi - a.roi);

      const formattedRoiDetails = data.roiDetails.map(({ tokenSymbol, roi }) => `${tokenSymbol} \`${roi}%\``);
      const formattedCallDetails = data.callDetails.slice(0, 3).map(({ tokenSymbol, roi }) => `${tokenSymbol} \`${roi}%\``);

      const formattedGroupDetails = [...data.groupDetails].map((channelId) => {
        const channel = client.channels.cache.get(channelId);
        return channel ? channel.name : `Unknown Channel (${channelId})`;
      });

      // Add fields to embed in rows with bold headers
      embed.addFields(
        {
          name: `**#${index + 1}. ${username}**`,
          value: `Winrate: \`${winRate}%\` ${getEmojiForWinRate(winRate)} | Avg ROI: \`${avgRoi}%\` ${getEmojiForRoi(avgRoi)}
          Wins: \`${data.wins}\` | Losses: \`${data.losses}\` | Total Calls: \`${data.wins + data.losses}\``,
          inline: false,
        },
        { name: '**Tokens Called and ROIs:**', value: formattedRoiDetails.join("\n") || "None", inline: true },
        { name: '**Most Recent Calls:**', value: formattedCallDetails.join("\n") || "None", inline: true },
        { name: '**Groups:**', value: formattedGroupDetails.join("\n") || "None", inline: true }
      );
    });

    // Send the embed to the alert channel
    alertChannel.send({ embeds: [embed] });
  }

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
          tokenName: null,
          tokenSymbol: null,
        },
      ];
      // saveCaTrackerToFile();
      // Continue with alerting or any other logic
      await checkAndSendAlert(ca);
    });
  }
});

client.once("ready", () => {
  console.log("Bot is online!");
  console.log(`Logged in as ${client.user.tag}!`);
  setInterval(checkAllTimeHighs, CHECK_INTERVAL);
});

client.login(BOT_TOKEN);
