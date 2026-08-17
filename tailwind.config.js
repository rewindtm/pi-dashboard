/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: '#0f1115',
        panel: '#171a21',
        border: '#2a2e38',
        accent: '#4f8cff',
      },
    },
  },
  plugins: [],
};
