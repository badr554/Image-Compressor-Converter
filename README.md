# PixelSqueeze

PixelSqueeze is a static browser-based image compression, conversion, and resizing site. Image files are processed in the visitor’s browser. The site uses plain HTML, CSS, and JavaScript.

## Folder structure
- Root HTML files: tools and site information
- `blog/`: article listing and editorial guides
- `css/style.css`: shared design system
- `js/`: interface, image processing, worker code, and self-hosted pinned vendor libraries (`pako` 2.1.0, `UPNG.js` 2.1.0, `JSZip` 3.10.1)
- `fonts/` and `css/fonts.css`: self-hosted Inter webfont and its font-face declaration
- `favicon.svg`, `og-image.png`: site identity and social preview
- `sitemap.xml`, `robots.txt`, `ads.txt`, `vercel.json`: crawler and deployment configuration

## Deploy on Vercel
1. Commit the project to Git or use Vercel’s static upload flow.
2. Import the repository and select its root directory.
3. Use the “Other” framework preset; leave build command and output directory empty.
4. Deploy a preview and manually check tool flows, then assign the production domain.
5. Verify canonical URLs, sitemap, 404 handling, and social previews after deployment.

## Replace placeholders
- Contact: the contact page opens an email to `badrsalah012@gmail.com`; confirm the inbox receives messages.
- Search Console: replace `YOUR_VERIFICATION_CODE` comments in page heads with the exact supplied meta tag and remove comment markers.
- AdSense: the approved publisher script is installed in page heads. Add only the exact authorized seller declaration from your account to ads.txt; do not guess publisher IDs.
- Domain: update `https://pixelsqueeze.site` in canonical, Open Graph, structured data, and sitemap URLs if the live domain changes; review `robots.txt` too.

## Lighthouse checklist
Check mobile and desktop layout; headings, titles, descriptions, canonical URLs, and image alt text; image dimensions and transfer size; keyboard navigation, visible focus, contrast, and link labels; console errors and failed requests; production Core Web Vitals; and policy text against the third-party scripts actually enabled.

## Manual test list
Open each page directly and follow its links. Compress, resize, and convert sample JPEG, PNG, and WebP files; verify dimensions and transparency. Try a large image and an undecodable file. Test worker and main-thread fallback in browsers with and without OffscreenCanvas. Open the contact page and verify Send email opens a message draft. Request a nonexistent route and confirm the custom 404 page. Inspect sitemap and robots endpoints and social metadata. The browser QA harness also covers GIF first-frame conversion, EXIF rotation, ZIP output, 50-file cleanup, target-size compression and malicious filenames.
