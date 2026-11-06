import { useState } from "react";
import { Mail } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { AUTH_API_ORIGIN } from "../services/api";

export default function Login() {
  const [searchParams] = useSearchParams();
  const [message, setMessage] = useState(() => {
    const error = searchParams.get("authError");
    if (error === "invalid_state") return "Your sign-in session could not be verified. Please make sure cookies are enabled and try again.";
    if (error === "google_denied") return "Google sign-in was cancelled.";
    if (error === "google_auth_failed") return "Google sign-in could not be completed. Please verify your account and try again.";
    return "";
  });

  function startGoogleLogin() {
    window.location.assign(new URL("/api/auth/google", AUTH_API_ORIGIN).toString());
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={(event) => {
        event.preventDefault();
        setMessage("Email/password sign-in is unavailable because the backend does not provide an authentication endpoint.");
      }}>
        <div className="login-mark"><Mail size={18} /></div>
        <h1>Welcome back</h1>
        <p className="login-description">Sign in to your ReachInbox workspace</p>
        <button className="google-login" type="button" onClick={startGoogleLogin}>
          <span className="google-g" aria-hidden="true">G</span>
          Login with Google
        </button>
        <div className="login-divider"><span />or sign up through email<span /></div>
        <label className="login-field">Email ID<input type="email" autoComplete="email" placeholder="you@example.com" /></label>
        <label className="login-field">Password<input type="password" autoComplete="current-password" placeholder="Enter your password" /></label>
        <button className="login-submit" type="submit">Login</button>
        {message && <p className="login-error" role="alert">{message}</p>}
        <p className="login-hint">Sign in securely with your Google account.</p>
      </form>
    </main>
  );
}
