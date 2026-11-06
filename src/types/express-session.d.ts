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
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}
