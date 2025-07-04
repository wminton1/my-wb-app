// server.js - Collaborative Whiteboard with Lobby System
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store active rooms and their data
const rooms = new Map();
const connectedUsers = new Map();

// Room states
const ROOM_STATES = {
  LOBBY: 'lobby',
  ACTIVE: 'active',
  ENDED: 'ended'
};

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Basic route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Create a new room (host only)
  socket.on('create-room', (data) => {
    console.log('Create room request:', data);
    const { roomId, username, role } = data;
    
    if (!roomId || !username) {
      console.log('Invalid room creation data');
      socket.emit('error', { message: 'Invalid room data' });
      return;
    }
    
    // Check if room already exists
    if (rooms.has(roomId)) {
      console.log(`Room ${roomId} already exists`);
      socket.emit('room-exists');
      return;
    }
    
    try {
      // Create new room
      const newRoom = {
        id: roomId,
        host: socket.id,
        state: ROOM_STATES.LOBBY,
        participants: new Map(),
        drawings: [],
        backgroundImage: null,
        settings: {
          hostCanClear: true,
          hostCanMute: true,
          participantsCanDraw: true,
          participantsCanChat: true,
          maxParticipants: 50
        },
        createdAt: Date.now()
      };
      
      // Add host to room
      newRoom.participants.set(socket.id, {
        id: socket.id,
        username: username,
        role: 'host',
        ready: true, // Host is always ready
        joinedAt: Date.now()
      });
      
      rooms.set(roomId, newRoom);
      socket.join(roomId);
      socket.roomId = roomId;
      socket.username = username;
      socket.role = 'host';
      
      connectedUsers.set(socket.id, {
        roomId,
        username,
        role: 'host'
      });
      
      console.log(`✅ Room created successfully: ${roomId} by ${username}`);
      
      socket.emit('room-created', {
        roomId: roomId,
        participants: Array.from(newRoom.participants.values())
      });
      
    } catch (error) {
      console.error('Error creating room:', error);
      socket.emit('error', { message: 'Failed to create room' });
    }
  });
  
  // Join an existing room
  socket.on('join-room', (data) => {
    const { roomId, username, role } = data;
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('room-not-found');
      return;
    }
    
    if (room.participants.size >= room.settings.maxParticipants) {
      socket.emit('room-full');
      return;
    }
    
    // Add participant to room
    room.participants.set(socket.id, {
      id: socket.id,
      username: username,
      role: 'participant',
      ready: false,
      joinedAt: Date.now()
    });
    
    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username;
    socket.role = 'participant';
    
    connectedUsers.set(socket.id, {
      roomId,
      username,
      role: 'participant'
    });
    
    console.log(`${username} joined room: ${roomId}`);
    
    // Notify participant
    socket.emit('room-joined', {
      roomId: roomId,
      participants: Array.from(room.participants.values())
    });
    
    // Notify all participants in the room
    io.to(roomId).emit('lobby-updated', {
      participants: Array.from(room.participants.values())
    });
  });
  
  // Toggle ready state (participants only)
  socket.on('toggle-ready', (data) => {
    if (!socket.roomId || socket.role !== 'participant') return;
    
    const room = rooms.get(socket.roomId);
    if (room && room.participants.has(socket.id)) {
      const participant = room.participants.get(socket.id);
      participant.ready = data.ready;
      
      // Notify all participants
      io.to(socket.roomId).emit('lobby-updated', {
        participants: Array.from(room.participants.values())
      });
      
      console.log(`${socket.username} is ${data.ready ? 'ready' : 'not ready'}`);
    }
  });
  
  // Start session (host only)
  socket.on('start-session', () => {
    if (!socket.roomId || socket.role !== 'host') return;
    
    const room = rooms.get(socket.roomId);
    if (room && room.state === ROOM_STATES.LOBBY) {
      room.state = ROOM_STATES.ACTIVE;
      
      // Notify all participants that session is starting
      io.to(socket.roomId).emit('session-starting');
      
      // After a short delay, fully start the session
      setTimeout(() => {
        io.to(socket.roomId).emit('session-started', {
          roomState: room.state,
          settings: room.settings,
          participants: Array.from(room.participants.values())
        });
      }, 1000);
      
      console.log(`Session started in room: ${socket.roomId}`);
    }
  });
  
  // Handle drawing events (only during active session)
  socket.on('drawing', (data) => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    if (!room || room.state !== ROOM_STATES.ACTIVE) return;
    
    const participant = room.participants.get(socket.id);
    if (!participant) return;
    
    // Check if participant can draw
    const canDraw = participant.role === 'host' || room.settings.participantsCanDraw;
    if (!canDraw) return;
    
    const drawingData = {
      ...data,
      userId: socket.id,
      username: socket.username,
      role: socket.role,
      timestamp: Date.now()
    };
    
    // Only store actual drawing points, not start/stop events
    if (data.type === 'draw') {
      room.drawings.push(drawingData);
    }
    
    // Broadcast all events (start, draw, stop) to other users
    socket.to(socket.roomId).emit('drawing', drawingData);
  });
  
  // Handle chat messages
  socket.on('chat-message', (message) => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    if (!room) return;
    
    const participant = room.participants.get(socket.id);
    if (!participant) return;
    
    // Check if participant can chat
    const canChat = participant.role === 'host' || room.settings.participantsCanChat;
    if (!canChat) return;
    
    const chatData = {
      username: socket.username,
      role: socket.role,
      message: message,
      timestamp: Date.now()
    };
    
    // Broadcast to all users in the room
    io.to(socket.roomId).emit('chat-message', chatData);
  });
  
  // Handle background image sharing
  socket.on('background-image', (data) => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    if (room) {
      // Store the background image in room data
      room.backgroundImage = {
        dataUrl: data.dataUrl,
        filename: data.filename,
        sharedBy: socket.username,
        timestamp: Date.now()
      };
      
      // Broadcast to all users in the room
      io.to(socket.roomId).emit('background-image', {
        dataUrl: data.dataUrl,
        filename: data.filename,
        sharedBy: socket.username
      });
      
      console.log(`${socket.username} shared background image: ${data.filename}`);
    }
  });
  
  // Handle text events
  socket.on('text-started', (data) => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    const participant = room?.participants.get(socket.id);
    
    if (room && participant) {
      const canDraw = participant.role === 'host' || room.settings.participantsCanDraw;
      if (!canDraw) return;
      
      const textData = {
        ...data,
        userId: socket.id,
        username: socket.username,
        role: socket.role
      };
      
      socket.to(socket.roomId).emit('text-started', textData);
    }
  });
  
  socket.on('text-typing', (data) => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    const participant = room?.participants.get(socket.id);
    
    if (room && participant) {
      const canDraw = participant.role === 'host' || room.settings.participantsCanDraw;
      if (!canDraw) return;
      
      const textData = {
        ...data,
        userId: socket.id,
        username: socket.username,
        role: socket.role
      };
      
      // Broadcast live typing to other users
      socket.to(socket.roomId).emit('text-typing', textData);
    }
  });
  
  socket.on('text-completed', (data) => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    const participant = room?.participants.get(socket.id);
    
    if (room && participant) {
      const canDraw = participant.role === 'host' || room.settings.participantsCanDraw;
      if (!canDraw) return;
      
      const textData = {
        ...data,
        userId: socket.id,
        username: socket.username,
        role: socket.role
      };
      
      // Store completed text
      if (data.text && data.text.trim()) {
        room.drawings.push({
          type: 'text',
          ...textData,
          timestamp: Date.now()
        });
      }
      
      socket.to(socket.roomId).emit('text-completed', textData);
    }
  });
  
  // Handle clear canvas (hosts only by default)
  socket.on('clear-canvas', () => {
    if (!socket.roomId) return;
    
    const room = rooms.get(socket.roomId);
    if (room && (socket.role === 'host' || !room.settings.hostCanClear)) {
      room.drawings = [];
      io.to(socket.roomId).emit('clear-canvas', {
        clearedBy: socket.username,
        role: socket.role
      });
    }
  });
  
  // Host controls
  socket.on('toggle-participant-drawing', () => {
    if (!socket.roomId || socket.role !== 'host') return;
    
    const room = rooms.get(socket.roomId);
    if (room) {
      room.settings.participantsCanDraw = !room.settings.participantsCanDraw;
      
      io.to(socket.roomId).emit('settings-updated', {
        settings: room.settings,
        updatedBy: socket.username
      });
    }
  });
  
  socket.on('toggle-participant-chat', () => {
    if (!socket.roomId || socket.role !== 'host') return;
    
    const room = rooms.get(socket.roomId);
    if (room) {
      room.settings.participantsCanChat = !room.settings.participantsCanChat;
      
      io.to(socket.roomId).emit('settings-updated', {
        settings: room.settings,
        updatedBy: socket.username
      });
    }
  });
  
  socket.on('kick-participant', (targetUserId) => {
    if (!socket.roomId || socket.role !== 'host') return;
    
    const targetSocket = io.sockets.sockets.get(targetUserId);
    if (targetSocket && targetSocket.roomId === socket.roomId) {
      targetSocket.emit('kicked', {
        by: socket.username,
        reason: 'Removed by host'
      });
      targetSocket.disconnect();
    }
  });
  
  // Handle leaving room
  socket.on('leave-room', () => {
    leaveRoom(socket);
  });
  
  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    leaveRoom(socket);
  });
  
  function leaveRoom(socket) {
    const userInfo = connectedUsers.get(socket.id);
    if (userInfo) {
      const room = rooms.get(userInfo.roomId);
      if (room) {
        room.participants.delete(socket.id);
        
        // If host leaves, end the room
        if (socket.role === 'host') {
          io.to(userInfo.roomId).emit('room-ended', {
            reason: 'Host left the room'
          });
          rooms.delete(userInfo.roomId);
          console.log(`Room ${userInfo.roomId} ended - host left`);
        } else {
          // Notify others about participant leaving
          socket.to(userInfo.roomId).emit('lobby-updated', {
            participants: Array.from(room.participants.values())
          });
          
          // If session is active, also notify about session participant leaving
          if (room.state === ROOM_STATES.ACTIVE) {
            socket.to(userInfo.roomId).emit('participant-left-session', {
              username: userInfo.username,
              role: userInfo.role,
              participants: Array.from(room.participants.values())
            });
          } else {
            socket.to(userInfo.roomId).emit('user-left', {
              username: userInfo.username,
              role: userInfo.role
            });
          }
        }
        
        // Clean up empty rooms
        if (room.participants.size === 0) {
          rooms.delete(userInfo.roomId);
          console.log(`Room ${userInfo.roomId} cleaned up`);
        }
      }
      
      connectedUsers.delete(socket.id);
    }
  }
});

// API endpoints
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    state: room.state,
    participantCount: room.participants.size,
    maxParticipants: room.settings.maxParticipants,
    createdAt: room.createdAt,
    host: Array.from(room.participants.values()).find(p => p.role === 'host')?.username
  }));
  res.json(roomList);
});

app.get('/api/room/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (room) {
    res.json({
      id: req.params.id,
      state: room.state,
      participantCount: room.participants.size,
      participants: Array.from(room.participants.values()),
      settings: room.settings,
      createdAt: room.createdAt
    });
  } else {
    res.status(404).json({ error: 'Room not found' });
  }
});

// Room cleanup - remove inactive rooms older than 24 hours
setInterval(() => {
  const now = Date.now();
  const ROOM_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_TIMEOUT && room.participants.size === 0) {
      rooms.delete(roomId);
      console.log(`Cleaned up inactive room: ${roomId}`);
    }
  }
}, 60 * 60 * 1000); // Check every hour

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Collaborative Whiteboard with Lobby System running on port ${PORT}`);
  console.log(`🌐 Local access: http://localhost:${PORT}`);
  console.log(`📡 Network access: http://[YOUR-IP]:${PORT}`);
  console.log(`🎯 Room-based collaboration enabled`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Server shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
  });
});
