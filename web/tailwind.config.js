/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#090a0c',
        surface: {
          DEFAULT: '#111317',
          muted: '#0d0f12',
          card: '#15181e',
          hover: '#1c2027',
          active: '#222730',
          border: '#21252d',
          'border-bold': '#2c323d',
        },
        sentinel: {
          lime: '#ccff00',
          'lime-hover': '#b8e600',
          'lime-muted': 'rgba(204, 255, 0, 0.1)',
          'lime-border': 'rgba(204, 255, 0, 0.25)',
          black: '#090a0c',
        },
        primary: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          DEFAULT: '#ccff00',
        },
        status: {
          pending: '#6b7280',
          running: '#38bdf8',
          verified: '#22c55e',
          awaiting: '#f59e0b',
          accepted: '#10b981',
          integrating: '#a855f7',
          integrated: '#22c55e',
          failed: '#ef4444',
          rejected: '#f43f5e',
          needshuman: '#f59e0b',
          cancelled: '#4b5563',
        }
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
        sans: ['Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      borderRadius: {
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
      }
    },
  },
  plugins: [],
}
