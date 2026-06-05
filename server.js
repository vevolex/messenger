const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose(); // Veritabanı modülünü dahil ettik

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 📦 VERİTABANI BAĞLANTISI VE TABLO OLUŞTURMA
const db = new sqlite3.Database('./chat.db', (err) => {
    if (err) console.error("Veritabanı hatası:", err.message);
    console.log('📦 SQLite veritabanı aktif.');
});

// Mesajların tutulacağı 'messages' tablosunu oluştur (Eğer yoksa)
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

io.on('connection', (socket) => {
    
    // Kullanıcı odaya girdiğinde
    socket.on('join_room', (data) => {
        socket.join(data.room);
        socket.username = data.user;
        socket.room = data.room;

        io.to(data.room).emit('room_stats', { count: getRoomCount(data.room) });
        socket.to(data.room).emit('system_message', `${data.user} sohbete katıldı.`);

        // ESKİ MESAJLARI GETİR: Odaya ait geçmiş mesajları veritabanından çek
        db.all("SELECT * FROM messages WHERE room = ? ORDER BY id ASC", [data.room], (err, rows) => {
            if (err) {
                console.error(err);
                return;
            }
            // Çekilen eski mesajları sadece odaya yeni giren kişiye gönder
            socket.emit('message_history', rows);
        });
    });

    // Yeni mesaj gönderildiğinde
    socket.on('send_message', (data) => {
        const simdi = new Date();
        const saat = String(simdi.getHours()).padStart(2, '0');
        const dakika = String(simdi.getMinutes()).padStart(2, '0');
        const timeStr = `${saat}:${dakika}`;

        const msgData = { ...data, time: timeStr };

        // MESAJI VERİTABANINA KAYDET
        db.run(`INSERT INTO messages (room, user, message, time) VALUES (?, ?, ?, ?)`, 
            [data.room, data.user, data.message, timeStr], 
            function(err) {
                if (err) return console.log(err.message);
                
                // Veritabanına başarıyla kaydedildikten sonra odadaki herkese ilet
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
            io.to(oda).emit('room_stats', { count: getRoomCount(oda) });
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Database Destekli Messenger hazır: http://localhost:${PORT}`);
});