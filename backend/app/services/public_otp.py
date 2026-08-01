"""OTP delivery abstraction for public registration.

Supported modes:
* ``development``: returns a debug OTP only outside production.
* ``email``: sends the OTP through authenticated SMTP (Gmail App Password or
  another SMTP provider).
* ``webhook``: retained for backward compatibility with an external gateway.

No production mode silently falls back to displaying or logging the OTP.
"""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage

import httpx

from app.core.config import get_settings

log = logging.getLogger("davangere.public_otp")


def mask_email(value: str) -> str:
    """Return a display-safe email address without exposing the full mailbox."""
    local, separator, domain = value.partition("@")
    if not separator:
        return "***"
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}{'*' * max(3, len(local) - len(visible))}@{domain}"


def _send_smtp_otp(*, recipient: str, code: str) -> None:
    settings = get_settings()
    provider = settings.email_provider.strip().lower()
    if provider != "smtp":
        raise RuntimeError("EMAIL_PROVIDER must be set to smtp")

    username = settings.smtp_username.strip()
    app_password = "".join(settings.smtp_app_password.split())
    sender = settings.smtp_from_email.strip() or username
    if not settings.smtp_host.strip() or not username or not app_password or not sender:
        raise RuntimeError(
            "SMTP email delivery is not configured. Set SMTP_HOST, SMTP_PORT, "
            "SMTP_USERNAME, SMTP_APP_PASSWORD, and SMTP_FROM_EMAIL."
        )

    message = EmailMessage()
    message["Subject"] = "Your Davanagere Smart Urban Survey verification code"
    message["From"] = f"{settings.smtp_from_name} <{sender}>"
    message["To"] = recipient
    message.set_content(
        "Your Davanagere Smart Urban Survey verification code is "
        f"{code}.\n\nThis code expires in {settings.public_otp_ttl_minutes} minutes. "
        "Do not share it with anyone.\n\nIf you did not request this code, "
        "you can safely ignore this email."
    )
    message.add_alternative(
        f"""
        <html>
          <body style="font-family:Arial,sans-serif;color:#102a43;line-height:1.5">
            <div style="max-width:560px;margin:0 auto;padding:24px;border:1px solid #d7e9df;border-radius:14px">
              <h2 style="margin-top:0;color:#006b45">Davanagere Smart Urban Survey</h2>
              <p>Use this verification code to create your public account:</p>
              <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0;color:#0b5137">{code}</p>
              <p>This code expires in <strong>{settings.public_otp_ttl_minutes} minutes</strong>.</p>
              <p style="font-size:13px;color:#5b6b7a">Do not share this code. If you did not request it, ignore this email.</p>
            </div>
          </body>
        </html>
        """,
        subtype="html",
    )

    context = ssl.create_default_context()
    with smtplib.SMTP(
        settings.smtp_host.strip(),
        settings.smtp_port,
        timeout=settings.smtp_timeout_seconds,
    ) as server:
        server.ehlo()
        if settings.smtp_use_starttls:
            server.starttls(context=context)
            server.ehlo()
        server.login(username, app_password)
        server.send_message(message)


async def deliver_registration_otp(*, email: str, phone: str, code: str) -> None:
    settings = get_settings()
    mode = settings.public_otp_mode.strip().lower()

    if mode == "development":
        if settings.app_env == "production":
            raise RuntimeError("Development OTP mode is disabled in production")
        log.info("Development registration OTP generated for %s", mask_email(email))
        return

    if mode == "email":
        try:
            await asyncio.to_thread(_send_smtp_otp, recipient=email, code=code)
        except Exception:
            log.exception("SMTP OTP delivery failed for %s", mask_email(email))
            raise
        return

    if mode != "webhook" or not settings.public_otp_webhook_url:
        raise RuntimeError(
            "Public OTP delivery is not configured. Set PUBLIC_OTP_DELIVERY=email "
            "with SMTP settings, or configure webhook mode."
        )

    headers = {"Content-Type": "application/json"}
    if settings.public_otp_webhook_token:
        headers["Authorization"] = f"Bearer {settings.public_otp_webhook_token}"

    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.post(
            settings.public_otp_webhook_url,
            headers=headers,
            json={
                "email": email,
                "phone": phone,
                "otp": code,
                "purpose": "public_registration",
                "message": f"Your Davanagere Smart Urban Survey verification code is {code}.",
            },
        )
        response.raise_for_status()
