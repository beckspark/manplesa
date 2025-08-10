import eventSourcesJSON from '@/assets/event_sources.json';
import { logTimeElapsedSince, serverCacheMaxAgeSeconds, serverStaleWhileInvalidateSeconds, serverFetchHeaders, applyEventTags } from '@/utils/util';
import { url } from 'inspector';
import { DateTime } from 'luxon';
const isDevelopment = process.env.NODE_ENV === 'development';

export default defineCachedEventHandler(async (event) => {
	const startTime = new Date();
	const body = await fetchlibnetEvents();
	logTimeElapsedSince(startTime.getTime(), 'libnet: events fetched.');
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

function cleanVenueDescription(venueDescription: String) {
	let cleanVenueDescription;
	const description = venueDescription; // Get the description string

	// Ensure description is treated as a string, defaulting to empty if it's null/undefined/other
	const descriptionString = typeof description === 'string' ? description : '';

	// Regular expression to find the first <p> tag and capture its content
	// <p[^>]*>     : Matches the opening <p tag, allowing for attributes (like <p class="...">)
	// ([\s\S]*)    : This is the capturing group. It matches any character ([\s\S] is a common way to include newlines) zero or more times.
	// </p>         : Matches the closing </p> tag.
	// The regex is non-greedy by default in JavaScript, so it will find the *first* closing </p> after the opening <p>.
	const firstParagraphRegex = /<p[^>]*>([\s\S]*)<\/p>/;

	const match = descriptionString.match(firstParagraphRegex);

	// Check if the regex found a match AND the first capturing group (the content inside <p>) exists
	if (match && match[1] !== undefined) {
		// If a match is found, take the content from the first capturing group (match[1])
		// .trim() removes any leading or trailing whitespace from the captured content.
		cleanVenueDescription = match[1].trim();
	} else {
		// If no <p>...</p> block was found, use the entire original description string.
		cleanVenueDescription = descriptionString;
	}

	// Now the 'location' variable holds the extracted content or the full description.
	// You would then use 'location' in the rest of your function/code block.
	return cleanVenueDescription;
}

async function fetchlibnetEvents() {
	const eventType = 0;
	const req = {
		"private": false,
		"date": new Date().toISOString().split('T')[0],
		"days": 60,
		"locations": [2317],
		"ages": [],
		"types": []
	};
	const reqJsonString = JSON.stringify(req);

	console.log('Fetching libnet events...');
	let libnetSources = await useStorage().getItem('libnetSources');
	try {
		libnetSources = await Promise.all(
			eventSourcesJSON.libnet.map(async (source) => {
				const finalSourceUrl = source.url + '?event_type=' + eventType + '&req=' + reqJsonString;
				const response = await fetch(finalSourceUrl, { headers: serverFetchHeaders });
				if (!response.ok) {
					console.error('[libnet] Error: could not fetch events from', source.url);
					return {
						events: [],
						city: 'DC',
						name: source.name,
					} as EventNormalSource;
				}
				const libnetJson = await response.json();

				return {
					events: libnetJson.map(event => convertlibnetEventToFullCalendarEvent('America/New_York', event, source)),
					city: 'DC',
					name: source.name,
				} as EventNormalSource;
			})
		);
		await useStorage().setItem('libnetSources', libnetSources);
	} catch (e) {
		console.log('Error fetching libnet events: ', e);
	}
	return libnetSources;
};

function convertlibnetEventToFullCalendarEvent(timeZone: string, e, source) {
	let start = DateTime.fromSQL(e.raw_start_time, { zone: timeZone });
	let end = DateTime.fromSQL(e.raw_end_time, { zone: timeZone });
	let url = e.url.replace(/([^:]\/)\/+/g, '$1'); // Remove extra forward slash
	let title = e.title;
	let description = e.description;
	if (('online_registration' in e && 'in_person_registration' in e && 'registration_enabled' in e) && //If you have to register
		(e.online_registration || e.in_person_registration || e.registration_enabled))
		description = description + '<br /><a href="' + url + '">For more information and to register check out the full page here!</a>';
	else description = description + '<br /><a href="' + url + '">For more information check out the full page here!</a>';
	let location = cleanVenueDescription(e.venue_description);
	// Append or prepend text if specified in the source
	if (source.prefixTitle) { title = source.prefixTitle + title; }
	if (source.suffixTitle) { title += source.suffixTitle; }

	if (e.location) description = 'Location: ' + e.location + '<br />' + description;
	if (e.categories_arr) e.categories_arr.forEach(category => { description = description + '<br />Category: ' + category.name });

	let eventTags = e.tagsArray.map(tag => {
		const tagString = String(tag);
		return tagString.toLowerCase().replace(/ /g, '_');
	});
	const tags = applyEventTags(source, title, description, eventTags);

	if (isDevelopment) title = tags.length + " " + title;

	return {
		id: formatTitleAndDateToID(start.toUTC().toJSDate(), title),
		title: title,
		org: source.name + ": " + e.calendar,
		start: start.toISO(),
		end: end.toISO(),
		url: url,
		description: description,
		images: e.event_image ? ['https://static.libnet.info/images/events/dclibrary/' + e.event_image] : [],//if it's an image, attach it (add checking logic later)
		location: location,
		tags,
	};
}
