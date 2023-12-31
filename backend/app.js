const express = require('express');
const axios = require('axios');
const https = require('https');
const OpenAI = require('openai').default;
const cors = require('cors');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Configuración de la conexión a la base de datos
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

db.connect((err) => {
    if (err) {
        throw err;
    }
    console.log('Conectado a la base de datos');
});

// Clave secreta para JWT
const jwtSecret = process.env.JWT_SECRET;

// Ruta raíz para verificar que el backend está funcionando
app.get('/', (req, res) => {
    res.send('Backend está funcionando!');
});

// Endpoint para iniciar sesión
app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).send('Please complete all fields');
    }
    const sql = 'SELECT * FROM users WHERE email = ?';
    db.query(sql, [email], async (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message: 'Server error' });
        }
        if (results.length === 0) {
            return res.status(401).json({ message: 'Email not found' });
        }
        const user = results[0];

        if (!user.is_verified) {
            return res.status(401).json({ message: 'Unverified email. Please verify your email to activate your account.' });
        }

        try {
            if (await bcrypt.compare(password, user.password)) {
                const token = jwt.sign({ userId: user.id_user }, jwtSecret, { expiresIn: '1h' });
                res.json({ token, message: 'Successful login' });
            } else {
                res.status(401).json({ message: 'Incorrect password' });
            }
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: 'Server error' });
        }
    });
});

// endpoint para crear usuarios
app.post('/create-user', async (req, res) => {
    const { username, name, lastname, email, password } = req.body;
    if (!username || !password || !email || !name || !lastname) {
        return res.status(400).send('Please complete all fields.');
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 8);
        const sql = 'INSERT INTO users (username, name, lastname, email, password) VALUES (?, ?, ?, ?, ?)';
        db.query(sql, [username, name, lastname, email, hashedPassword], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error registering user');
            }

            // Generar un token de verificación
            const verificationToken = generateVerificationToken(email); // Asegúrate de que esta función esté definida y accesible

            // Guardar el token en la base de datos para el usuario
            const updateSql = 'UPDATE users SET verification_token = ? WHERE email = ?';
            db.query(updateSql, [verificationToken, email], (err, updateResult) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error saving verification token');
                }

                // Enviar correo electrónico con el token de verificación
                sendVerificationEmail(email, verificationToken);
                res.status(201).json({ message: 'Registered user successfully. Check your email.' });
            });
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error en el servidor');
    }
});

// Función para generar un token de verificación
function generateVerificationToken( email ) {
    return jwt.sign({ email }, jwtSecret, { expiresIn: '24h' }); // Asegúrate de que este token sea único y seguro.
}

let transporter = nodemailer.createTransport({
    host: 'mail.storylinematch.com', 
    port: 465,
    secure: true,
    auth: {
        user: 'no-reply@storylinematch.com',
        pass: process.env.PASS_EMAIL
    }
});

function sendVerificationEmail(email, token) {
    
    const verificationUrl = `https://storylinematch.com/verify-email?token=${token}`;

    let mailOptions = {
        from: 'no-reply@storylinematch.com',
        to: email,
        subject: 'Email verification - StoryLineMatch',
        html: `Hi y'all. Welcome to storylinematch!<br>Please click this link to verify your email: <a href="${verificationUrl}">${verificationUrl}</a>`
    };

    transporter.sendMail(mailOptions, function (error, info) {
        if (error) {
            console.log(error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });
}

app.get('/verify-email', (req, res) => {
    const { token } = req.query;

    try {
        const { email } = jwt.verify(token, jwtSecret);
        const sql = 'UPDATE users SET is_verified = TRUE WHERE email = ?';

        db.query(sql, [email], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message: 'Server error' });
            }
            if (result.affectedRows === 0) {
                return res.status(404).json({ message: 'User not found or already verified' });
            }

            res.json({ message: 'Email successfully verified. You are being redirected...' });
        });
    } catch (err) {
        res.status(400).json({ message: 'Invalid or expired token' });
    }
});

app.post('/request-reset-password', (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ message:'Email is required'});
    }

    const sql = 'SELECT * FROM users WHERE email = ?';
    db.query(sql, [email], (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ message:'Server error'});
        }
        if (results.length === 0) {
            return res.status(404).json({ message: 'Email not found' });
        }
        
        const user = results[0];

        // Comprobar si el usuario está verificado
        if (!user.is_verified) {
            return res.status(401).json({ message: 'Email not verified. Please verify your account first.' });
        }

        const resetToken = generateResetToken(email); // Esta función debe ser implementada para generar un token

        // Guardar el token en la base de datos
        const updateSql = 'UPDATE users SET reset_token = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE email = ?';
        db.query(updateSql, [resetToken, email], (updateErr, updateResult) => {
            if (updateErr) {
                console.error(updateErr);
                return res.status(500).json({ message:'Error saving reset token'});
            }

            // Enviar correo electrónico con el enlace de restablecimiento
            sendResetPasswordEmail(email, resetToken); // Esta función debe ser implementada para enviar el correo
            res.status(200).json({ message:'Reset password link sent to your email'});
        });
    });
});

function generateResetToken(email) {
    // Implementa tu lógica para generar un token seguro aquí
    return jwt.sign({ email }, jwtSecret, { expiresIn: '1h' });
}

function sendResetPasswordEmail(email, token) {
    const resetUrl = `https://storylinematch.com/reset-password?token=${token}`;
    // Implementa tu lógica para enviar correo electrónico aquí
    
      const mailOptions = {

        from: 'no-reply@storylinematch.com',
        to: email,
        subject: 'Password reset - Storylinematch',
        html: `Please click the following link to reset your password: <a href="${resetUrl}">${resetUrl}</a>`
      };
    
      transporter.sendMail(mailOptions, function(error, info) {
        if (error) {
          console.error('Error sending email', error);
        } else {
          console.log('Email sent: ' + info.response);
        }
      });
}

app.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
        return res.status(400).json({ message:'Token and new password are required'});
    }

    // Verificar el token y obtener el email
    try {
        const { email } = jwt.verify(token, jwtSecret);
        const hashedPassword = await bcrypt.hash(newPassword, 8);

        // Actualizar la contraseña del usuario
        const sql = 'UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE email = ? AND reset_token = ?';
        db.query(sql, [hashedPassword, email, token], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ message:'Server error'});
            }
            if (result.affectedRows === 0) {
                return res.status(400).json({ message:'Invalid or expired reset token'});
            }

            res.status(200).json({ message:'Password has been reset successfully. Redirecting...'});
        });
    } catch (err) {
        res.status(400).json({ message:'Invalid or expired token'});
    }
});

// Endpoint para generar respuesta de OpenAI
app.post('/generate-response', async (req, res) => {

    const prompt = `
    You are a movie expert.
    I am going to give you a description of a story and I want you to give me a list of 10 movies that most closely resemble the story I am going to give you.
    Give me only one json, I don't want any message before or after it.
    Your input will always be a story of a movie if you think that what the user provides you is not related or is not a story from a movie just send me back this:
    
    {
    "error" : "The input provided does not appear to be a movie story."
    }
    
    your output must always be in valid JSON format like this: 
    
    movie_list: [
        {
          title: "",
          release_year: ""
        }
    input: I want movies about ` + req.body.prompt;

    if (!prompt) {
        return res.status(400).send('No prompt provided');
    }
    try {
        const completion = await openai.chat.completions.create({
            messages: [{ role: "user", content: prompt }],
            model: "gpt-3.5-turbo",
        });
        res.json({ response: completion.choices[0].message.content });
    } catch (error) {
        console.error('Error calling OpenAI:', error);
        res.status(500).send('Error processing request');
    }
});

app.get('/search-movie', (req, res) => {
    const { title, year } = req.query;
    rapidAPIKey = process.env.RAPID_API_KEY

    if (!title || !year) {
        return res.status(400).send('You must provide a title and year.');
    }

    const encodedTitle = encodeURIComponent(title);
    const options = {
        method: 'GET',
        hostname: 'moviesdatabase.p.rapidapi.com',
        port: null,
        path: `/titles/search/title/${encodedTitle}?exact=true&info=base_info&year=${year}&titleType=movie`,
        headers: {
            'X-RapidAPI-Key': rapidAPIKey,
            'X-RapidAPI-Host': 'moviesdatabase.p.rapidapi.com'
        }
    };

    const reqApi = https.request(options, function (resApi) {
        const chunks = [];

        resApi.on('data', function (chunk) {
            chunks.push(chunk);
        });

        resApi.on('end', function () {
            const body = Buffer.concat(chunks);
            res.send(body.toString());
        });
    });

    reqApi.on('error', function (e) {
        console.error(`problem with request: ${e.message}`);
        res.status(500).send(e.message);
    });

    reqApi.end();
});

const authenticateToken = (req, res, next) => {
    // Obtener el token del encabezado de la solicitud
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (token == null) {
        return res.sendStatus(401); // No token provided
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decodedToken) => {
        if (err) {
            return res.sendStatus(403); // Token no válido o expirado
        }
        req.id_user = decodedToken.userId;
        next();
    });
};

module.exports = authenticateToken;

// insertar historia de busqueda en el historial
// a traves del authenticate desciframos el id del usuario

app.post('/insert-story-history', authenticateToken, (req, res) => {
    const idUser = req.id_user; // Obtiene el id_user del middleware
    const { query, movies_data } = req.body;

    const sql = 'INSERT INTO story_history (id_user, query, movies_data) VALUES (?, ?, ?)';
    db.query(sql, [idUser, query, movies_data], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error inserting into database');
        }
        res.status(201).json({ message: 'History inserted successfully' });
    });
});

app.get('/get-story-history', authenticateToken, (req, res) => {
    const idUser = req.id_user; // Asume que este es el ID del usuario obtenido del token

    const sql = 'SELECT movies_data, query FROM story_history WHERE id_user = ?';
    db.query(sql, [idUser], (err, results) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error al recuperar las historias');
        }
        res.json(results);
    });
});

app.post('/insert-favorite-movie', authenticateToken, (req, res) => {
    const idUser = req.id_user; // Obtiene el id_user del middleware
    const { title, movieData } = req.body;

    // Primero, verifica si el título ya existe para este usuario
    const checkSql = 'SELECT * FROM favorite_movies WHERE id_user = ? AND title = ?';
    db.query(checkSql, [idUser, title], (checkErr, checkResult) => {
        if (checkErr) {
            console.error(checkErr);
            return res.status(500).send('Error al verificar la película');
        }

        if (checkResult.length > 0) {
            // Si la película ya existe, envía una respuesta indicando esto
            return res.status(409).json({ message: 'La película favorita ya existe' });
        } else {
            // Si no existe, procede a insertar la nueva película
            const insertSql = 'INSERT INTO favorite_movies (id_user, title, movie_data) VALUES (?, ?, ?)';
            db.query(insertSql, [idUser, title, movieData], (insertErr, insertResult) => {
                if (insertErr) {
                    console.error(insertErr);
                    return res.status(500).send('Error al insertar en la base de datos');
                }
                res.status(201).json({ message: 'Película favorita insertada con éxito' });
            });
        }
    });
});

app.get('/get-favorite-movies', authenticateToken, (req, res) => {
    const idUser = req.id_user; // Obtiene el id_user del middleware

    const sql = 'SELECT movie_data FROM favorite_movies WHERE id_user = ?';
    db.query(sql, [idUser], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error al obtener las películas favoritas');
        }
        res.status(200).json(result);
    });
});

app.delete('/delete-favorite-movie/:title', authenticateToken, (req, res) => {
    const idUser = req.id_user; // Obtiene el id_user del middleware
    const title = req.params.title; // Obtiene el título de los parámetros de la URL

    // SQL para eliminar la película basándose en el título
    const sql = 'DELETE FROM favorite_movies WHERE id_user = ? AND title = ?';
    db.query(sql, [idUser, title], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error deleting movie from database');
        }

        if (result.affectedRows === 0) {
            // Si no se encontró la película (o no pertenece al usuario), enviar un mensaje adecuado
            return res.status(404).json({ message: 'Movie not found or does not belong to the user' });
        }

        res.status(200).json({ message: 'Successfully deleted movie' });
    });
});

app.get('/user-info', authenticateToken, (req, res) => {
    const userId = req.id_user; // Obtenido del token JWT por el middleware authenticateToken

    const sql = 'SELECT username, name, lastname, email, created_at FROM users WHERE id_user = ?';
    db.query(sql, [userId], (err, result) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error en el servidor');
        }
        if (result.length === 0) {
            return res.status(404).send('Usuario no encontrado');
        }

        res.json(result[0]);
    });
});


// Iniciar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor escuchando en el puerto ${PORT}`);
});