import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// handle shows a username as @name, unless it is an email address.
export function handle(username: string) {
  return username.includes('@') ? username : '@' + username
}
