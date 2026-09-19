/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        ink: 'var(--ink)',
        g100: 'var(--g100)',
        g300: 'var(--g300)',
        g500: 'var(--g500)',
        g700: 'var(--g700)',
        accent: 'var(--accent)',
        gain: 'var(--gain)',
        loss: 'var(--loss)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
      },
      spacing: {
        unit: 'var(--unit)',
      },
      fontFamily: {
        sans: ['Public Sans Variable', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
      },
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1.5' }],
        sm: ['0.875rem', { lineHeight: '1.5' }],
        base: ['1rem', { lineHeight: '1.5' }],
        lg: ['1.25rem', { lineHeight: '1.5' }],
        xl: ['1.75rem', { lineHeight: '1.25' }],
        amount: ['2.5rem', { lineHeight: '1.25', letterSpacing: '-0.025em' }],
      },
    },
  },
  plugins: [],
}
