export const USERS = {
  leo: {
    id: "000997.3647cff9cc2b42359d6ca7f79a0f2c91.0428",
  },
  gab: {
    id: "000859.740385afd8284174a94c84e9bcc9bdea.1440",
  },
  savio: {
    id: "12151123201",
  },
  benny: {
    id: "benante.m",
  },
  peter: {
    id: "12182998998",
  },
} as const;

export type UserKey = keyof typeof USERS;

export function resolveUserId(user: string) {
  return USERS[user as UserKey]?.id || user;
}

export function getUsersList() {
  return Object.entries(USERS).map(([key, user]) => ({
    key,
    ...user,
  }));
}