const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 📦 VERİTABANI BAĞLANTISI VE TABLO OLUŞTURMA
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error("Veritabanı hatası:", err.message);
    console.log('📦 SQLite veritabanı aktif.');
});

db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT,
    user TEXT,
    message TEXT,
    time TEXT
)`);

app.use(express.static(path.join(__dirname, 'public')));

function getRoomCount(roomName) {
    const room = io.sockets.adapter.rooms.get(roomName);
    return room ? room.size : 0;
}

// YENİ ÖZELLİK: Odadaki kullanıcıların isimlerini listeleyen fonksiyon
function getRoomUsers(roomName) {
    const room = io.sockets.adapter.rooms.get(roomName);
    if (!room) return [];
    let users = [];
    for (const socketId of room) {
        const clientSocket = io.sockets.sockets.get(socketId);
        if (clientSocket && clientSocket.username) {
            users.push(clientSocket.username);
        }
    }
    return [...new Set(users)]; // Aynı isimden birden fazla varsa teke düşürür
}

io.on('connection', (socket) => {
    
    socket.on('join_room', (data) => {
        socket.join(data.room);
        socket.username = data.user;
        socket.room = data.room;
        
        io.to(data.room).emit('system_message', `${data.user} sohbete katıldı.`);
        // Güncellendi: Artık kullanıcı listesi de gönderiliyor
        io.to(data.room).emit('room_stats', { count: getRoomCount(data.room), users: getRoomUsers(data.room) });
        
        db.all(`SELECT user, message, time FROM messages WHERE room = ? ORDER BY id ASC`, [data.room], (err, rows) => {
            if (err) return console.log(err.message);
            socket.emit('message_history', rows);
        });
    });

    socket.on('leave_room', () => {
        if (socket.username && socket.room) {
            const oda = socket.room;
            socket.leave(oda);
            io.to(oda).emit('system_message', `${socket.username} odadan ayrıldı.`);
            io.to(oda).emit('room_stats', { count: getRoomCount(oda), users: getRoomUsers(oda) });
            socket.username = null;
            socket.room = null;
        }
    });

    socket.on('send_message', (data) => {
        const simdi = new Date();
        const saat = String(simdi.getHours()).padStart(2, '0');
        const dakika = String(simdi.getMinutes()).padStart(2, '0');
        const timeStr = `${saat}:${dakika}`;

        const msgData = { ...data, time: timeStr };

        db.run(`INSERT INTO messages (room, user, message, time) VALUES (?, ?, ?, ?)`, 
            [data.room, data.user, data.message, timeStr], 
            function(err) {
                if (err) return console.log(err.message);
                io.to(data.room).emit('receive_message', msgData);
            }
        );
    });

    socket.on('typing', (data) => {
        socket.to(data.room).emit('user_typing', { user: data.user, isTyping: data.isTyping });
    });

    socket.on('disconnect', () => {
        if (socket.username && socket.room) {
            const oda = socket.room;
            io.to(oda).emit('system_message', `${socket.username} sohbetten ayrıldı.`);
            io.to(oda).emit('room_stats', { count: getRoomCount(oda), users: getRoomUsers(oda) });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Sunucu http://localhost:${PORT} adresinde çalışıyor`);
});