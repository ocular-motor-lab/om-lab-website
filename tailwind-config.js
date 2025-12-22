// tailwind-config.js
// Shared configuration for Ocular-Motor lab website

// Safely initialize the tailwind object on the window if it doesn't exist yet
window.tailwind = window.tailwind || {};

window.tailwind.config = {
    theme: {
        extend: {
            fontFamily: {
                // Changed default font stack to Helvetica with system fallbacks
                sans: ['Helvetica', 'ui-sans-serif', 'sans-serif'],
            },
            colors: {
                // Brand colors extracted from logo.png
                'brand-lime': '#D7DF21',
                'brand-gray': '#939598',
                'brand-black': '#000000',

                // Functional mappings
                'nav-blue': '#ffffffff', // Replaced Navy with Black (brand-black)
                'accent-blue': '#D7DF21', // Replaced Blue with Lime (brand-lime)

                // New color for text links to ensure readability on white backgrounds
                // (Lime is too light for text on white)
                'accent-text': '#4b5563', // Dark gray (Gray 600)
            },
            boxShadow: {
                // Custom shadow for a more premium, modern lift effect
                'lifted': '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
            },
            // Custom grid-template-rows for smooth height transition (used in people.html)
            gridTemplateRows: {
                '0fr': '0fr',
                '1fr': '1fr',
            },
            // Custom transition properties if needed
            transitionProperty: {
                'height': 'height',
                'max-height': 'max-height',
            }
        }
    }
};