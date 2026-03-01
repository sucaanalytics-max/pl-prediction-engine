/** @type {import('tailwindcss').Config} */
module.exports = {
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
          500: '#2aad1f',
          600: '#1d8c14',
          700: '#196e13',
          800: '#185714',
          900: '#154812',
          950: '#052706',
        },
        slate: {
          850: '#172032',
          925: '#0d1420',
          950: '#080d16',
        },
      },
      fontFamily: {
        display: ['var(--font-jakarta)', 'system-ui', 'sans-serif'],
        body: ['var(--font-jakarta)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.5s ease-out',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(42, 173, 31, 0)' },
          '50%': { boxShadow: '0 0 20px 4px rgba(42, 173, 31, 0.15)' },
        },
      },
    },
  },
  plugins: [],
};
