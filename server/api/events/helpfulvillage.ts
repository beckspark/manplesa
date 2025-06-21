import eventSourcesJSON from '@/assets/event_sources.json';
import { JSDOM } from 'jsdom';
import { logTimeElapsedSince, serverCacheMaxAgeSeconds, serverStaleWhileInvalidateSeconds, serverFetchHeaders, applyEventTags } from '@/utils/util';
import { url } from 'inspector';
import { DateTime } from 'luxon';
const isDevelopment = process.env.NODE_ENV === 'development';

export default defineCachedEventHandler(async (event) => {
	const startTime = new Date();
	const body = await fetchhelpfulvillageEvents();
	logTimeElapsedSince(startTime.getTime(), 'helpfulvillage: events fetched.');
	return {
		body
	}
}, {
	maxAge: serverCacheMaxAgeSeconds,
	staleMaxAge: serverStaleWhileInvalidateSeconds,
	swr: true,
});

function formatTitleAndDateToID(inputDate: any, title: string) {
	const date = new Date(inputDate);
	const year = date.getFullYear().toString().slice(-2); // Get last 2 digits of year
	const month = (date.getMonth() + 1).toString().padStart(2, '0'); // Get month (0-11) and format to 2 digits
	const day = date.getDate().toString().padStart(2, '0');
	const hours = date.getHours().toString().padStart(2, '0');
	const minutes = date.getMinutes().toString().padStart(2, '0');
  
    // Function to get the first three URL-compatible characters from the title
    function getFirstThreeUrlCompatibleChars(inputTitle: string): string {
        // Define URL-compatible characters (alphanumeric and some special characters)
        const urlCompatibleChars = /^[A-Za-z]+$/;

		// Ensure inputTitle is a string to prevent the "undefined is not iterable" error
		inputTitle = inputTitle || 'und';
        // Filter out non-URL-compatible characters and take the first three
        return Array.from(inputTitle)
            .filter(char => urlCompatibleChars.test(char))
            .slice(0, 3)
            .join('')
            .toLowerCase();
    }

    // Extract the first three URL-compatible characters from the title
    const titlePrefix = getFirstThreeUrlCompatibleChars(title);
  
	return `${year}${month}${day}${hours}${minutes}${titlePrefix}`;
}

async function getHelpfulVillageEventDetails(eventId: number): Promise<{ startDate?: string; endDate?: string; location?: string; description?: string }> {
    const url = `https://mountpleasant.helpfulvillage.com/events/${eventId}`;
    const response = await fetch(url);
    if (!response.ok) return {};
    const html = await response.text();
    const dom = new JSDOM(html);

	// Find members-only events
    const membersOnlyDiv = Array.from(dom.window.document.querySelectorAll('div')).find(div =>
        div.textContent?.toLowerCase().includes('members only')
    );
    if (membersOnlyDiv) {
        return {
            startDate: '',
            endDate: '',
            location: '',
            description: 'membersOnly'
        };
    }

    // Get all ld+json scripts
    const scripts = Array.from(dom.window.document.querySelectorAll('script[type="application/ld+json"]'));

    // Look for the one wrapped in CDATA
    const cdataScript = scripts.find(script => script.textContent?.includes('//<![CDATA['));
    if (!cdataScript?.textContent) return {};

    // Clean the CDATA wrapping
    const jsonText = cdataScript.textContent
        .replace('//<![CDATA[', '')
        .replace('//]]>', '')
        .trim();

    let data;
    try {
        data = JSON.parse(jsonText);
    } catch (err) {
        console.warn('[helpfulvillage] Failed to parse ld+json for event', eventId, err);
        return {};
    }

    return {
        startDate: data.startDate || '',
        endDate: data.endDate || '',
        location: data.location?.name || '',
        description: data.description || '',
    };
}

async function fetchhelpfulvillageEvents() {
	const startDate = new Date();
	const endDate = new Date();
	endDate.setDate(startDate.getDate() + 30);
	const formattedStart = startDate.toISOString().split('T')[0];
	const formattedEnd = endDate.toISOString().split('T')[0];

	console.log('Fetching helpfulvillage events...');
	let helpfulvillageSources = await useStorage().getItem('helpfulvillageSources');
	try {
		helpfulvillageSources = await Promise.all(
			eventSourcesJSON.helpfulvillage.map(async (source) => {
				const finalSourceUrl = `${source.url}?=&start=${formattedStart}&end=${formattedEnd}`;
				const response = await fetch(finalSourceUrl, { headers: serverFetchHeaders });
				if (!response.ok) {
					console.error('[helpfulvillage] Error: could not fetch events from', source.url);
					return {
						events: [],
						city: 'DC',
						name: source.name,
					} as EventNormalSource;
				}
				const helpfulvillageJson = await response.json();

				const enrichedEvents = await Promise.all(
					helpfulvillageJson.map(async (event) => {
						const match = event.url?.match(/\/events\/(\d+)/);
						const eventId = match ? parseInt(match[1], 10): null;

						if (!eventId) {
							console.warn('[helpfulvillage] Could not extract event ID from URL:', event.url);
							return null; // Return null for events without a valid ID
						}

						const details = await getHelpfulVillageEventDetails(eventId);

						if (details.description === 'membersOnly') {
							return null; // Skip members-only events
						}

						const enrichedEvent = {
							...event,
							eventId: eventId,
							startDate: details.startDate,
							endDate: details.endDate,
							location: details.location,
							description: details.description,
						};
						// console.log(converthelpfulvillageEventToFullCalendarEvent('America/New_York', enrichedEvent, source)); // uncomment to view the final event for debugging
						return converthelpfulvillageEventToFullCalendarEvent('America/New_York', enrichedEvent, source);
					})
				);

				const filteredEnrichedEvents = enrichedEvents.filter(event => event !== null); // filter out member's only events

				return {
					events: filteredEnrichedEvents,
					city: 'DC',
					name: source.name,
				} as EventNormalSource;
			})
		);
		await useStorage().setItem('helpfulvillageSources', helpfulvillageSources);
	} catch (e) {
		console.log('Error fetching helpfulvillage events: ', e);
	}
	return helpfulvillageSources;
}

function converthelpfulvillageEventToFullCalendarEvent(timeZone: string, e, source) {
	let start = DateTime.fromISO(e.startDate);
	let end = DateTime.fromISO(e.endDate);
	let url = `https://mountpleasant.helpfulvillage.com/events/${e.eventId}`
	let title = e.title;
	let description = e.description;
	if	(('online_registration' in e && 'in_person_registration' in e && 'registration_enabled' in e) && //If you have to register
		(e.online_registration||e.in_person_registration||e.registration_enabled))
		description = description + '<br /><a href="'+url+'">For more information and to register check out the full page here!</a>';
	else description = description + '<br /><a href="'+url+'">For more information check out the full page here!</a>';
	let location = e.location;
	// Append or prepend text if specified in the source
	if (source.prefixTitle) { title = source.prefixTitle + title; }
	if (source.suffixTitle) { title += source.suffixTitle; }

	if (e.location) description = 'Location: '+e.location+'<br />'+description;

	const tags = applyEventTags(source, title, description);

	if (isDevelopment) title=tags.length+" "+title;

	return {
		id: formatTitleAndDateToID(start.toUTC().toJSDate(), title),
		title: title,
		org: source.name+": "+e.calendar,
		start: start.toUTC().toJSDate(),
		end: end.toUTC().toJSDate(),
		url: url,
		description: description,
		images: e.featured_image ? [e.featured_image] : [],//if it's an image, attach it (add checking logic later)
		location: location,
		tags,
	};
}
