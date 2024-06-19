import "dotenv/config";
import express from "express";
import WebSocket from "ws";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import axios from "axios";

const app = express();
app.use(cookieParser());
const HTTP_PORT = process.env.HTTP_PORT;
const WS_PORT = process.env.WS_PORT as unknown as number;
const DATABASE_URL = process.env.DATABASE_URL;
const VERIFY_API = process.env.VERIFY_API as string;

mongoose.connect(`${DATABASE_URL}`);
const Schema = mongoose.Schema;
const messageSchema = new Schema({
  from: String,
  to: String,
  message: String,
  timestamp: { type: Date, default: Date.now },
});
const Message = mongoose.model("Message", messageSchema);

const wss = new WebSocket.Server({ port: WS_PORT });
console.log(`WebSocket server started on port ${WS_PORT}`);

const clients = new Map();

wss.on("connection", async (ws: WebSocket, req: any) => {
  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });

  const headers = req.headers;
  if (!headers) {
    ws.close(4001, "No headers");
    return;
  }

  const token = headers.jwt;
  if (!token) {
    ws.close(4002, "No JWT token");
    return;
  }
  const user = await authenticateJWT(token);
  if (!user) {
    ws.close(4003, "Invalid JWT token");
    return;
  }

  let username = user.name;
  clients.set(username, ws);
  console.log(`User ${username} connected`);

  await deliverStoredMessagesFromDb(username, ws);

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

// Endpoint to retrieve chat history for a specific user
app.get("/chat/history/:userId", async (req, res) => {
  const userId = req.params.userId;
  try {
    const messages = await Message.find({
      $or: [{ from: userId }, { to: userId }],
    }).sort({ timestamp: 1 });
    res.json(messages);
  } catch (error) {
    console.error("Error retrieving chat history:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT}`);
});

const deliverStoredMessagesFromDb = async (username: string, ws: WebSocket) => {
  try {
    const messages = await Message.find({ to: username }).sort({
      timestamp: 1,
    });
    if (ws.readyState === WebSocket.OPEN) {
      messages.forEach((message) => {
        ws.send(JSON.stringify(message));
      });
    } else {
      console.error("WebSocket is not open: ", ws.readyState);
    }
  } catch (error) {
    console.error("Error retrieving stored messages from MongoDB:", error);
  }
};

const handleMessage = async (username: string, data: any) => {
  const msg = new Message({
    from: username,
    to: data.to,
    message: data.message,
  });

  try {
    await msg.save();
    const recipientWs = clients.get(data.to);

    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
      recipientWs.send(
        JSON.stringify({ from: username, message: data.message })
      );
    } else {
      // Optionally handle offline user case (store message in MongoDB)
      console.log(`User ${data.to} is offline, message stored in MongoDB`);
    }
  } catch (error) {
    console.error("Error saving message to MongoDB:", error);
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
};
