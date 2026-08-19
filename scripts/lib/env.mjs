// Key loading. Reads .env.local (git-ignored) so the key never has to be pasted into
// a shell, a chat window, or a command line where it would land in history.
import { readFileSync, existsSync } from 'node:fs'

export function loadKey() {
  if (process.env.YOUTUBE_API_KEY) return process.env.YOUTUBE_API_KEY
  const path = new URL('../../.env.local', import.meta.url)
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*YOUTUBE_API_KEY\s*=\s*(.+?)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  }
  console.error('No YOUTUBE_API_KEY found.')
  console.error(
    'Create one at https://console.cloud.google.com (enable "YouTube Data API v3"),',
  )
  console.error('then put it in .env.local as:  YOUTUBE_API_KEY=your-key-here')
  process.exit(2)
}
