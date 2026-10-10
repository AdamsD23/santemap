/**
 * Envoi d'e-mails (SMTP). Sans SMTP_HOST, rien n'est envoyé : les notifications restent dans l'application.
 * Un échec d'envoi ne bloque jamais l'action de l'utilisateur : il est seulement écrit dans les journaux.
 */

const nodemailer = require('nodemailer');
const config = require('../config');

let transport;

/** Pour les tests : remplace le transport SMTP par un faux */
function utiliserTransport(t) {
    transport = t;
}

function obtenirTransport() {
    if (transport !== undefined) return transport;
    if (!config.SMTP_HOST) return null;
    transport = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        ...(config.SMTP_USER && { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } })
    });
    return transport;
}

const echapper = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Envoie une notification par e-mail ; renvoie true si elle est partie */
async function envoyerNotification(email, titre, message) {
    const t = obtenirTransport();
    if (!t || !email) return false;
    try {
        await t.sendMail({
            from: config.MAIL_FROM,
            to: email,
            subject: `SantéMap : ${titre}`,
            text: `${message}\n\n— SantéMap\nVous recevez ce message parce que vous avez un compte SantéMap. Retrouvez toutes vos notifications dans l'application.`,
            html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#13252b">
                <h2 style="color:#0e6b45;margin:0 0 12px">${echapper(titre)}</h2>
                <p style="font-size:15px;line-height:1.5">${echapper(message)}</p>
                <p style="font-size:12px;color:#5b6d73;margin-top:24px">SantéMap — vous recevez ce message parce que vous avez un compte SantéMap.</p></div>`
        });
        return true;
    } catch (err) {
        console.error(`E-mail non envoyé (${titre}) : ${err.message}`);
        return false;
    }
}

module.exports = { envoyerNotification, utiliserTransport };
