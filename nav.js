/**
 * Renders the fixed navigation bar into a designated target element.
 * * @param {string} currentPage - The filename of the current page (e.g., 'index.html', 'people.html').
 */
function renderNavigation(currentPage) {
    // Define the structure of the navigation links
    const navItems = [
        { href: 'index.html', title: 'Home' },
        { href: 'publications.html', title: 'Publications/Data/Code' },
        { href: 'people.html', title: 'People' },
    ];

    // Function to generate the HTML for the menu links
    const navLinksHtml = navItems.map(item => {
        // Determine if the current link is for the active page
        const isActive = item.href === currentPage;

        // Use different Tailwind classes for the active link
        const activeClass = isActive
            ? 'font-bold text-brand-black block'
            : 'text-brand-gray font-medium transition duration-150 block hover:text-brand-lime hover:font-bold';

        return `
            <li class="px-4 py-2 md:p-0">
                <a href="${item.href}" class="${activeClass}">${item.title}</a>
            </li>
        `;
    }).join('');

    // The complete HTML structure for the navigation bar
    const navHtml = `
        <nav class="fixed top-0 left-0 right-0 z-50 bg-white shadow-xl">
            <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center h-20">
                <!-- Lab name/brand on the left -->
                <!-- Lab name/brand on the left -->
                <a href="index.html" class="flex items-center gap-3 text-brand-black transition duration-150 hover:text-brand-lime group">
                    <img src="images/logoh.png" alt="Ocular-Motor lab" class="h-14 w-auto object-contain">
                    <!--<span class="text-2xl sm:text-3xl font-extrabold tracking-wide">Ocular-Motor lab</span>-->
                </a>

                <!-- Mobile menu toggle button - ACCESSIBILITY -->
                <button id="menuToggle" 
                        class="text-brand-gray text-2xl md:hidden" 
                        onclick="toggleMenu()"
                        aria-label="Toggle navigation menu" 
                        aria-expanded="false" 
                        aria-controls="navList">
                    ☰
                </button>

                <!-- Menu items on the right -->
                <ul id="navList" 
                    class="hidden flex-col absolute top-full left-0 w-full bg-white 
                           py-2 md:flex md:flex-row md:relative md:top-auto md:w-auto md:space-x-6">
                    ${navLinksHtml}
                </ul>
            </div>
        </nav>
        
        <!-- Spacer element (h-16) to prevent content overlap -->
        <div class="h-16 w-full" aria-hidden="true"></div> 
    `;

    // Inject the navigation HTML at the beginning of the body
    document.body.insertAdjacentHTML('afterbegin', navHtml);

    // Also inject the favicon
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/png';
    favicon.href = 'images/favicon.png';
    document.head.appendChild(favicon);
}

/**
 * Toggles the mobile navigation menu and updates accessibility attributes.
 * This function needs to be globally accessible, so we define it here.
 */
function toggleMenu() {
    const navList = document.getElementById('navList');
    const menuButton = document.getElementById('menuToggle');

    const isClosed = navList.classList.contains('hidden');
    navList.classList.toggle('hidden');
    menuButton.setAttribute('aria-expanded', isClosed);
}