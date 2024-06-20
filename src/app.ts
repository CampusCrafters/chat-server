import "dotenv/config";
import express from "express";
import WebSocket from "ws";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import axios from "axios";
import cors from "cors";
import { createClient } from "redis";

const corsOptions = {
  origin: ["http://localhost:5173", "https://campustown.in"],
  credentials: true,
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());
const HTTP_PORT = process.env.HTTP_PORT;
const WS_PORT = process.env.WS_PORT as unknown as number;
const DATABASE_URL = process.env.DATABASE_URL;
const VERIFY_API = process.env.VERIFY_API as string;
const redisUrl = process.env.REDIS_URL;

mongoose.connect(`${DATABASE_URL}`);
const Schema = mongoose.Schema;
const messageSchema = new Schema({
  from: String,
  to: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model("Message", messageSchema);

const redisClient = createClient({
  url: `${redisUrl}`,
});
(async () => {
  await redisClient.connect();
})();

redisClient.on('connect', () => console.log('::> Redis Client Connected'));
redisClient.on('error', (err) => console.log('<:: Redis Client Error', err));
const wss = new WebSocket.Server({ port: WS_PORT });
console.log(`WebSocket server started on port ${WS_PORT}`);

const clients = new Map();

wss.on("connection", async (ws: WebSocket, req: any) => {
  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
  const token = req.headers.jwt;
  if (!token) {
    ws.close(4002, "No JWT token");
    return;
  }
  const user = await authenticateJWT(token);
  if (!user) {
    ws.close(4003, "Invalid JWT token");
    return;
  }

  let username = user.name.replace(" -IIITK", "");
  clients.set(username, ws);
  console.log(`User ${username} connected`);

  //await deliverStoredMessagesFromDb(username, ws);
  await deliverQueuedMessages(username, ws);

  ws.on("message", async (message: string) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (error: any) {
      console.error("Error parsing message:", error.message);
      return;
    }

    await handleMessage(username, data);
  });

  ws.on("close", () => {
    clients.delete(username);
    console.log(`User ${username} disconnected`);
  });

  ws.on("error", (error) => {
    console.log(`User ${username} disconnected due to error: ${error}`);
  });
});

app.get("/chat/:contact", async (req, res) => {
  const token = req.cookies.jwt;
  const user = await authenticateJWT(token);
  if (!user) {
    res.status(401).json({ error: "Token invalid" });
    return;
  }
  const username = user.name.replace(" -IIITK", "");
  const contactName = req.params.contact.replace(/^:\s*/, "").trim();
  try {
    const messages = await getConversation(contactName, username);
    res.json(messages);
  } catch (error: any) {
    console.error(`Error retrieving conversations`, error.message);
    return [];
  }
});

app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
});

/***************************************************************************************************/

const getConversation = async (contact: string, username: string) => {
  try {
    const messages = await Message.find({
      $or: [
        { from: username, to: contact },
        { from: contact, to: username },
      ],
    }).sort({ timestamp: 1 });
    return messages;
  } catch (error) {
    console.error("Error retrieving conversation from MongoDB:", error);
    return [];
  }
};
const handleMessage = async (username: string, data: any) => {
  const { to, message } = data;
  const recipientWs = clients.get(to);
  const newMessage = new Message({
    from: username,
    to,
    message,
  });
  await newMessage.save();

  if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
    recipientWs.send(JSON.stringify(JSON.stringify(newMessage)));
  } else {
    await redisClient.lPush(`messages:${to}`, JSON.stringify(newMessage));
    console.log(`User ${data.to} is offline, message pushed to queue and stored in MongoDB`);
  }
};

const deliverQueuedMessages = async (username: string, ws: WebSocket) => {
  try {
    while (true) {
      // Fetch a message from the user's Redis list
      const message = await redisClient.rPop(`messages:${username}`);

      // If there are no more messages, break the loop
      if (!message) {
        break;
      }

      // Send the message via WebSocket
      ws.send(message);
    }
  } catch (error) {
    console.error(`Error delivering messages to ${username}:`, error);
    // Optionally, handle the error (e.g., logging, retrying, etc.)
  }
};

const authenticateJWT = async (token: string) => {
  try {
    const response = await axios.post(VERIFY_API, { token: token });
    return response.data.decoded;
  } catch (error: any) {
    console.error("Error verifying JWT:", error.message);
    return null;
  }
}

// const deliverStoredMessagesFromDb = async (username: string, ws: WebSocket) => {
//   try {
//     const messages = await Message.find({ to: username }).sort({
//       timestamp: 1,
//     });
//     if (ws.readyState === WebSocket.OPEN) {
//       messages.forEach((message) => {
//         ws.send(JSON.stringify(message));
//       });
//     } else {
//       console.error("WebSocket is not open: ", ws.readyState);
//     }
//   } catch (error) {
//     console.error("Error retrieving stored messages from MongoDB:", error);
//   }
// };