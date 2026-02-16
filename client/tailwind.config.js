/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#207a57", // Nathiya Agri Agency green
          light: "#4aa87f",
          dark: "#165d43",
        },
      },
    },
  },
  darkMode: "class", // enable dark mode toggle with 'class'
  plugins: [],
};