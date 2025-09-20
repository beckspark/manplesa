import eventSourcesJSON from '@/assets/event_sources.json';
import { logTimeElapsedSince, serverCacheMaxAgeSeconds, serverFetchHeaders, serverStaleWhileInvalidateSeconds, applyEventTags } from '~~/utils/util';
import { JSDOM } from 'jsdom';
import { DateTime } from 'luxon';

export default defineCachedEventHandler(async (event) => {
	const startTime = new Date();
	const body = await fetchEventbriteEvents();
	logTimeElapsedSince(startTime, 'Eventbrite: events fetched.');
	return {
		body
	}
}, {
	maxAge: serverCacheMaxAgeSeconds,
	staleMaxAge: serverStaleWhileInvalidateSeconds,
	swr: true,
});

async function fetchEventbriteEvents() {
	console.log('Fetching Eventbrite events...');

	if (process.env.EVENTBRITE_API_KEY === undefined) {
		console.error("No Eventbrite API key found. Please set the EVENTBRITE_API_KEY environment variable.");
	}

	let eventbriteSources = await useStorage().getItem('eventbriteSources');
	try {
		eventbriteSources = await Promise.all(
			eventSourcesJSON.eventbriteAccounts.map(async (source) => {
				return await fetch(source.url, { headers: serverFetchHeaders })
					// Error check.
					.then(res => {
						if (!res.ok) {
							console.error(`Error fetching Eventbrite events for ${source.name}: ${res.status} ${res.statusText}`);
							return {
								events: [],
								city: source.city,
								name: source.name,
							} as EventNormalSource;
						}
						return res;
					})
					.then(res => res.text())
					.then(async html => {
						const dom = new JSDOM(html);
						const scripts = dom.window.document.querySelectorAll('script[type="application/ld+json"]');

						if (scripts.length < 2) {
							// Let's try the first script if we only have one
							if (scripts.length === 1) {
								try {
									const parsedData = JSON.parse(scripts[0].innerHTML);
									const eventsArray = Array.isArray(parsedData) ? parsedData : (parsedData?.events || parsedData?.itemListElement || []);
									const eventsRaw = eventsArray.map(eventWrapper => {
										const event = eventWrapper.item || eventWrapper;
										try {
											const convertedEvent = convertSchemaDotOrgEventToFullCalendarEvent(event, source);
											// Apply prefix and suffix titles
											if (source.prefixTitle) { convertedEvent.title = source.prefixTitle + convertedEvent.title; }
											if (source.suffixTitle) { convertedEvent.title += source.suffixTitle; }
											return convertedEvent;
										} catch (e) {
											console.warn(`${source.name}: Skipping event due to conversion error:`, e.message);
											return null;
										}
									}).filter(event => event !== null);
									const events = Promise.all(eventsRaw.map(async (rawEvent) => {
										const isLongerThan3Days = (rawEvent.end.getTime() - rawEvent.start.getTime()) / (1000 * 3600 * 24) > 3;
										if (isLongerThan3Days) {
											const eventSeries = await getEventSeries(rawEvent.url);
											return eventSeries.map(event => convertEventbriteAPIEventToFullCalendarEvent(event, source.name));
										} else {
											return rawEvent;
										}
									}));
									const newEvents = (await events).flat();
									return {
										events: newEvents,
										city: source.city,
										name: source.name,
									} as EventNormalSource;
								} catch (e) {
									// Silently handle parsing errors
								}
							}
							return {
								events: [],
								city: source.city,
								name: source.name,
							} as EventNormalSource;
						}

						let parsedData;
						try {
							parsedData = JSON.parse(scripts[1].innerHTML);
						} catch (e) {
							console.error(`Error parsing JSON for ${source.name}:`, e);
							return {
								events: [],
								city: source.city,
								name: source.name,
							} as EventNormalSource;
						}

						// Ensure we have an array to work with
						let eventsArray = [];
						if (Array.isArray(parsedData)) {
							eventsArray = parsedData;
						} else if (parsedData?.events) {
							eventsArray = parsedData.events;
						} else if (parsedData?.itemListElement) {
							eventsArray = parsedData.itemListElement;
						} else if (parsedData?.['@graph']) {
							eventsArray = parsedData['@graph'];
						}
						const eventsRaw = eventsArray.map(eventWrapper => {
							// Handle ListItem structure where actual event is in .item
							const event = eventWrapper.item || eventWrapper;
							try {
								const convertedEvent = convertSchemaDotOrgEventToFullCalendarEvent(event, source);
								// Apply prefix and suffix titles
								if (source.prefixTitle) { convertedEvent.title = source.prefixTitle + convertedEvent.title; }
								if (source.suffixTitle) { convertedEvent.title += source.suffixTitle; }
								return convertedEvent;
							} catch (e) {
								console.warn(`${source.name}: Skipping event due to conversion error:`, e.message);
								return null;
							}
						}).filter(event => event !== null);

						// Since public & private Eventbrite endpoints provides a series of events as a single event, we need to split them up using their API.
						const events = Promise.all(eventsRaw.map(async (rawEvent) => {
							const isLongerThan3Days = (rawEvent.end.getTime() - rawEvent.start.getTime()) / (1000 * 3600 * 24) > 3;
							if (isLongerThan3Days) {
								const eventSeries = await getEventSeries(rawEvent.url);
								return eventSeries.map(event => convertEventbriteAPIEventToFullCalendarEvent(event, source.name));
							} else {
								return rawEvent;
							}
						}));
						const newEvents = (await events).flat();

						return {
							events: newEvents,
							city: source.city,
							name: source.name,
						} as EventNormalSource;
					});
			}));
		const eventbriteSingleEventSeries = await Promise.all(
			eventSourcesJSON.eventbriteSingleEventSeries.map(async (source) => {
				const eventsSeries = (await getEventSeries(source.url)).map(event => convertEventbriteAPIEventToFullCalendarEvent(event, source.sourceName));
				return {
					events: eventsSeries,
					city: source.city,
					name: source.name,
				} as EventNormalSource;
			}));
		const allEventbriteSources = eventbriteSources.concat(eventbriteSingleEventSeries);
		await useStorage().setItem('eventbriteSources', allEventbriteSources);
		return allEventbriteSources;
	}
	catch (e) {
		console.error("Error fetching Eventbrite events: ", e);
	}
	return eventbriteSources;
};

async function getEventSeries(event_url: string) {
	// Split URL by '-' and get the last part.
	const series_id = event_url.split('-').pop();
	const res = await fetch(`https://www.eventbriteapi.com/v3/series/${series_id}/events/?token=${process.env.EVENTBRITE_API_KEY}`, { headers: serverFetchHeaders })
		.then((res) => {
			return res.json();
		});

	// Sometimes the response returns 404 for whatever reason. I imagine for events with information set to private. Ignore those.
	if (!res.events) {
		return [];
	} else {
		return res.events;
	};
}

function convertSchemaDotOrgEventToFullCalendarEvent(item, source) {
	// If we have a `geo` object, format it to geoJSON.
	var geoJSON = (item.location?.geo) ? {
		type: "Point",
		coordinates: [
			item.location.geo?.longitude,
			item.location.geo?.latitude
		]
		// Otherwise, set it to null.
	} : null;

	const title = `${item.name} @ ${source.name}`;
	const description = item.description + '<br /><a href="' + item.url + '">For more information and to register check out the full page here!</a>' || '';
	const tags = applyEventTags(source, title, description);

	return {
		title: title,
		// Converts from System Time to UTC.
		start: DateTime.fromISO(item.startDate).toUTC().toJSDate(),
		end: DateTime.fromISO(item.endDate).toUTC().toJSDate(),
		url: item.url,
		tags: tags,
		extendedProps: {
			description: description || null,
			// Normalize images to always be an array for consistency with other event sources
			images: item.image ? [item.image] : [],
			// Normalize location to be a simple string for consistency
			location: item.location?.name || 'Location not specified',
			// Include org name for consistency with other event sources
			org: source.name,
			// Keep the full location data for advanced use cases
			locationData: {
				geoJSON: geoJSON,
				eventVenue: {
					name: item.location?.name || null,
					address: {
						streetAddress: item.location?.streetAddress || null,
						addressLocality: item.location?.addressLocality || null,
						addressRegion: item.location?.addressRegion || null,
						postalCode: item.location?.postalCode || null,
						addressCountry: item.location?.addressCountry || null
					},
					geo: item.location?.geo || null
				}
			}
		}
	};
};

// The problem with the Eventbrite developer API format is that it lacks geolocation.
function convertEventbriteAPIEventToFullCalendarEvent(item, sourceName) {
	return {
		title: `${item.name.text} @ ${sourceName}`,
		start: new Date(item.start.utc),
		end: new Date(item.end.utc),
		url: item.url,
		extendedProps: {
			description: item.description?.text || null,
			// Normalize to empty images array for consistency
			images: [],
			// Normalize location for consistency
			location: 'Location not specified',
			// Include org name for consistency with other event sources
			org: sourceName,
		}
	};
};
