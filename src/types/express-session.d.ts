import "express-session";

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

declare module "express-session" {
  interface SessionData {
    user?: AuthenticatedUser;
    oauthState?: string;
    slackOauthState?: string;
    slackOauthStateCreatedAt?: number;
    gmailOauthState?: string;
    gmailOauthStateCreatedAt?: number;
    gmailOauthUserId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
