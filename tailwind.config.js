/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#0ca678',
          light: '#12b886',
          dark: '#099268',
        },
        surface: {
          light: '#f4f6f8',
          dark: '#0f1115',
        },
        panel: {
          light: '#ffffff',
          dark: '#171a21',
        },
        border: {
          light: '#e2e5ea',
          dark: '#2a2e38',
        },
        sidebar: '#0b1220',
        'sidebar-hover': '#141d31',
      },
    },
  },
  plugins: [],
};
