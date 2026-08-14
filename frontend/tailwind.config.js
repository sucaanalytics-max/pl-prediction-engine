/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        pitch: {
          50: '#f0fdf0',
          100: '#d9f7d6',
          200: '#b3efac',
          300: '#7de070',
          400: '#4bc83e',
          500: '#10b981', // Mapped to our new Electric Emerald
          600: '#059669',
          700: '#196e13',
          800: '#185714',
          900: '#154812',
          950: '#052706',
        },
        slate: {
          850: '#172032',
          925: '#0d1420',
          950: '#050b14', // Mapped to the new deep cyber dark
        },
      },
      // `--font-jakarta` no longer exists — the app is set in IBM Plex — so
      // `font-display` and `font-body` were resolving to system-ui wherever they
      // were used. Pointed at the tokens `globals.css` actually defines.
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.7s cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up': 'slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-glow': 'pulseGlow 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 4s linear infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', filter: 'blur(10px)' },
          '100%': { opacity: '1', filter: 'blur(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)', filter: 'blur(5px)' },
          '100%': { opacity: '1', transform: 'translateY(0)', filter: 'blur(0)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: '1', filter: 'brightness(1)' },
          '50%': { opacity: '0.8', filter: 'brightness(1.5) drop-shadow(0 0 15px rgba(0,255,163,0.5))' },
        },
      },
    },
  },
  plugins: [],
};
