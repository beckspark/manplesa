import eventSourcesJSON from '@/assets/event_sources.json';
import { logTimeElapsedSince, serverCacheMaxAgeSeconds, serverStaleWhileInvalidateSeconds, serverFetchHeaders, applyEventTags, extractBestImageFromHTML } from '@/utils/util';
import { DOMParser } from 'xmldom';
import { parse } from 'node-html-parser';
import { DateTime } from 'luxon';

const isDevelopment = process.env.NODE_ENV === 'development';

// RSS namespaces
const MEC_NAMESPACE = 'http://webnus.net/rss/mec/';
const CONTENT_NAMESPACE = 'http://purl.org/rss/1.0/modules/content/';
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';

export default defineCachedEventHandler(async (event) => {
    const startTime = new Date();
    const body = await fetchWordpressRssEvents();
    logTimeElapsedSince(startTime, 'WordPress RSS: events fetched.');
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

async function fetchWordpressRssEvents() {
    console.log('=== Fetching WordPress RSS events ===');
    console.log('Sources to fetch:', eventSourcesJSON.wordpressRss.length);
    let wordpressRssSources: EventNormalSource[] | null = await useStorage().getItem('wordpressRssSources');

    try {
        wordpressRssSources = await Promise.all(
            eventSourcesJSON.wordpressRss.map(async (source) => {
                try {
                    console.log(`Fetching from ${source.name}: ${source.url}`);
                    const response = await fetch(source.url, { headers: serverFetchHeaders });
                    if (!response.ok) {
                        console.error(`HTTP error! Status: ${response.status} from ${source.url}`);
                        return {
                            events: [],
                            city: source.city,
                            name: source.name,
                        } as EventNormalSource;
                    }
                const xmlText = await response.text();


                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(xmlText, 'text/xml');


                const parseError = xmlDoc.getElementsByTagName('parsererror');
                if (parseError.length > 0) {
                    console.warn(`XML Parsing Error for ${source.url}:`, parseError[0].textContent);
                    
                    return {
                        events: [],
                        city: source.city,
                        name: source.name,
                    } as EventNormalSource;
                }


                const items = Array.from(xmlDoc.getElementsByTagName('item'));

                const mecEvents = await Promise.all(items.map(async itemElement => {
                    if (source.isMEC) {
                        return convertMECRssEventToFullCalendarEvent(itemElement, source, 'America/New_York');
                    } else {
                        const event = convertStandardRssEventToFullCalendarEvent(itemElement, source, 'America/New_York');
                        // If event needs date extraction, scrape the individual page
                        if (event.extendedProps?.needsDateExtraction && event.url) {
                            return await enhanceEventWithPageData(event);
                        }
                        return event;
                    }
                }));

                    console.log(`Source ${source.name} processed ${mecEvents.length} events`);
                    return {
                        events: mecEvents,
                        city: source.city,
                        name: source.name,
                    } as EventNormalSource;
                } catch (error) {
                    console.error(`Error fetching from ${source.name}:`, error);
                    return {
                        events: [],
                        city: source.city,
                        name: source.name,
                    } as EventNormalSource;
                }
            })
        );
        await useStorage().setItem('wordpressRssSources', wordpressRssSources);
        console.log(`Final result: ${wordpressRssSources.length} sources with total events:`,
                   wordpressRssSources.map(s => `${s.name}: ${s.events.length}`));
    } catch (error) {
        console.error('Error fetching WordPress RSS events:', error);

        return [];
    }
    return wordpressRssSources;
}

function getElementTextNS(element: Element, namespaceURI: string | null, tagName: string): string | null {
    const nodes = element.getElementsByTagNameNS(namespaceURI, tagName);
    return nodes.length > 0 ? nodes[0].textContent : null;
}

function convertMECRssEventToFullCalendarEvent(itemElement: Element, source: any, timeZone: string) {
    // Standard RSS fields
    let title = itemElement.getElementsByTagName('title')[0]?.textContent || 'No Title';
    let link = itemElement.getElementsByTagName('link')[0]?.textContent || 'No Link';
    let pubDate = itemElement.getElementsByTagName('pubDate')[0]?.textContent || 'N/A';
    let creator = getElementTextNS(itemElement, DC_NAMESPACE, 'creator');

    // MEC custom fields
    const startDate = getElementTextNS(itemElement, MEC_NAMESPACE, 'startDate');
    const startHour = getElementTextNS(itemElement, MEC_NAMESPACE, 'startHour');
    const endDate = getElementTextNS(itemElement, MEC_NAMESPACE, 'endDate');
    const endHour = getElementTextNS(itemElement, MEC_NAMESPACE, 'endHour');
    const locationName = getElementTextNS(itemElement, MEC_NAMESPACE, 'location');
    const category = getElementTextNS(itemElement, MEC_NAMESPACE, 'category');

    // Event timezone parsing
    let eventStart: Date | null = null;
    let eventStartUTC: Date | null = null;

    if (startDate && startHour) {
        try {
            const startDateTimeLuxon = DateTime.fromFormat(
                `${startDate} ${startHour}`,
                'yyyy-MM-dd h:mm a',        
                { zone: timeZone }  
            );

            if (startDateTimeLuxon.isValid) {
                // Convert Luxon DateTime object to a native JavaScript Date object
                eventStart = startDateTimeLuxon.toJSDate();
                eventStartUTC = startDateTimeLuxon.toUTC().toJSDate();
            } else {
                console.error(`Luxon parse error for start date/time "${startDate} ${startHour}": ${startDateTimeLuxon.invalidExplanation}`);
            }
        } catch (e) {
            console.error(`Unexpected error during start date parsing: ${startDate} ${startHour}`, e);
        }
    }

    let eventEnd: Date | null = null;
    if (endDate && endHour) {
        try {
            const endDateTimeLuxon = DateTime.fromFormat(
                `${endDate} ${endHour}`,
                'yyyy-MM-dd h:mm a',
                { zone: timeZone }
            );

            if (endDateTimeLuxon.isValid) {
                eventEnd = endDateTimeLuxon.toJSDate();
            } else {
                console.error(`Luxon parse error for end date/time "${endDate} ${endHour}": ${endDateTimeLuxon.invalidExplanation}`);
            }
        } catch (e) {
            console.error(`Unexpected error during end date parsing: ${endDate} ${endHour}`, e);
        }
    } else {
        // If no explicit end date/time, assume it's the same as start
        eventEnd = eventStart;
    }

    // --- Description & Image Extraction ---
    let rawDescriptionHtml: string | null = null;
    let cleanDescription: string | null = null;
    let imageUrl: string | null = null;

    const contentEncodedHtml = getElementTextNS(itemElement, CONTENT_NAMESPACE, 'encoded');
    // Fallback to standard description if content:encoded is empty
    const standardDescriptionHtml = itemElement.getElementsByTagName('description')[0]?.textContent;

    if (contentEncodedHtml) {
        rawDescriptionHtml = contentEncodedHtml;
    } else if (standardDescriptionHtml) {
        rawDescriptionHtml = standardDescriptionHtml;
    }

    if (rawDescriptionHtml) {
        try {
            const root = parse(rawDescriptionHtml);

            // Extract image URL if an <img> tag exists
            const imgElement = root.querySelector('img');
            if (imgElement) {
                imageUrl = imgElement.getAttribute('src') || null;
            }

            cleanDescription = root.textContent?.trim() || null;

            if (cleanDescription) {
                cleanDescription = cleanDescription.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
            }

        } catch (e) {
            console.warn('Error parsing HTML description for image/text:', e);
            cleanDescription = rawDescriptionHtml;
        }
    }

    // Append the desciption with link for details
	let description = cleanDescription + '<br /><a href="'+link+'">For more information check out the full page here!</a>';

    // Format title
	if (source.prefixTitle) { title = source.prefixTitle + title; }
	if (source.suffixTitle) { title += source.suffixTitle; }

    // Add tags
    const tags = applyEventTags(source, title, cleanDescription || '');
    if (isDevelopment) title = tags.length + " " + title;

    return {
		id: eventStartUTC ? formatTitleAndDateToID(eventStartUTC, title) : null,
        title: title,
        org: source.name,
        start: eventStart,
        end: eventEnd,
        url: link,
        description: description,
        location: locationName,
		images: imageUrl ? [imageUrl] : [], //if it's an image, attach it (add checking logic later)
        tags: tags,
        extendedProps: {
            category: category,
            creator: creator
        }
    };
}

function convertStandardRssEventToFullCalendarEvent(itemElement: Element, source: any, timeZone: string) {
    // Standard RSS fields
    let title = itemElement.getElementsByTagName('title')[0]?.textContent || 'No Title';
    let link = itemElement.getElementsByTagName('link')[0]?.textContent || 'No Link';
    let pubDate = itemElement.getElementsByTagName('pubDate')[0]?.textContent || 'N/A';
    let creator = getElementTextNS(itemElement, DC_NAMESPACE, 'creator');

    // For standard WordPress RSS, we don't have event dates/times in the feed
    // We'll use the publication date as a fallback and mark these events as needing manual date extraction
    let eventStart: Date | null = null;
    let eventEnd: Date | null = null;

    if (pubDate && pubDate !== 'N/A') {
        try {
            // Parse pubDate and ensure it's in EST timezone
            const pubDateTime = DateTime.fromRFC2822(pubDate, { zone: 'America/New_York' });
            if (pubDateTime.isValid) {
                eventStart = pubDateTime.toJSDate();
                eventEnd = eventStart; // Default to same time for end
            } else {
                // Fallback to native Date parsing if RFC2822 fails
                eventStart = new Date(pubDate);
                eventEnd = eventStart;
            }
        } catch (e) {
            console.error(`Error parsing pubDate "${pubDate}":`, e);
        }
    }

    // --- Description & Image Extraction ---
    let rawDescriptionHtml: string | null = null;
    let cleanDescription: string | null = null;
    let imageUrl: string | null = null;

    const contentEncodedHtml = getElementTextNS(itemElement, CONTENT_NAMESPACE, 'encoded');
    const standardDescriptionHtml = itemElement.getElementsByTagName('description')[0]?.textContent;

    if (contentEncodedHtml) {
        rawDescriptionHtml = contentEncodedHtml;
    } else if (standardDescriptionHtml) {
        rawDescriptionHtml = standardDescriptionHtml;
    }

    if (rawDescriptionHtml) {
        try {
            const root = parse(rawDescriptionHtml);

            // Extract image URL if an <img> tag exists
            const imgElement = root.querySelector('img');
            if (imgElement) {
                imageUrl = imgElement.getAttribute('src') || null;
            }

            cleanDescription = root.textContent?.trim() || null;

            if (cleanDescription) {
                cleanDescription = cleanDescription.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
            }

        } catch (e) {
            console.warn('Error parsing HTML description for image/text:', e);
            cleanDescription = rawDescriptionHtml;
        }
    }

    // Append the description with link for details
    let description = cleanDescription + '<br /><a href="'+link+'">For more information check out the full page here!</a>';

    // Format title
    if (source.prefixTitle) { title = source.prefixTitle + title; }
    if (source.suffixTitle) { title += source.suffixTitle; }

    // Add tags
    const tags = applyEventTags(source, title, cleanDescription || '');
    if (isDevelopment) title = tags.length + " " + title;

    return {
        id: eventStart ? formatTitleAndDateToID(eventStart, title) : null,
        title: title,
        org: source.name,
        start: eventStart,
        end: eventEnd,
        url: link,
        description: description,
        location: null, // Standard RSS doesn't have location info
        images: imageUrl ? [imageUrl] : [],
        tags: tags,
        extendedProps: {
            category: null, // Standard RSS doesn't have category info
            creator: creator,
            needsDateExtraction: true // Flag to indicate this event needs proper date/time extraction
        }
    };
}

async function enhanceEventWithPageData(event: any) {
    try {
        console.log(`Enhancing event data for: ${event.title}`);
        const response = await fetch(event.url, { headers: serverFetchHeaders });
        if (!response.ok) {
            console.warn(`Failed to fetch event page: ${event.url}`);
            return event;
        }

        const html = await response.text();
        const root = parse(html);

        // Look for date/time patterns in the HTML
        const dateTimeInfo = extractDateTimeFromHTML(html, root);

        if (dateTimeInfo.start) {
            event.start = dateTimeInfo.start;
            event.end = dateTimeInfo.end || dateTimeInfo.start;
            // Update ID with proper date
            event.id = formatTitleAndDateToID(dateTimeInfo.start, event.title);
        }

        // Extract location information
        const location = extractLocationFromHTML(root);
        if (location) {
            event.location = location;
        }

        // Extract the best image from the page content
        const bestImage = extractBestImageFromHTML(root);
        if (bestImage) {
            event.images = [bestImage];
        }

        // Remove the needsDateExtraction flag since we've processed it
        delete event.extendedProps.needsDateExtraction;

        return event;
    } catch (error) {
        console.error(`Error enhancing event ${event.title}:`, error);
        return event;
    }
}

function extractDateTimeFromHTML(html: string, root: any) {
    // Look for Marx Cafe actual HTML format: <strong>Start Date:<span>2025/09/19 10:00 pm</span></strong>
    const startDateRegex = /<strong>Start Date:<span>(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)<\/span><\/strong>/i;
    const endDateRegex = /<strong>End Date:<span>(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(am|pm)<\/span><\/strong>/i;

    let startTime = null;
    let endTime = null;

    // Extract start date and time
    const startMatch = html.match(startDateRegex);
    if (startMatch) {
        console.log('Start date match found:', startMatch[0]);
        const [, year, month, day, hour, minute, period] = startMatch;
        let hourNum = parseInt(hour);
        if (period.toLowerCase() === 'pm' && hourNum !== 12) hourNum += 12;
        if (period.toLowerCase() === 'am' && hourNum === 12) hourNum = 0;

        // Create DateTime in EST timezone then convert to JavaScript Date
        const startDateTimeLuxon = DateTime.fromObject(
            {
                year: parseInt(year),
                month: parseInt(month),
                day: parseInt(day),
                hour: hourNum,
                minute: parseInt(minute)
            },
            { zone: 'America/New_York' }
        );

        if (startDateTimeLuxon.isValid) {
            startTime = startDateTimeLuxon.toJSDate();
            console.log('Parsed start time (EST):', startTime);
        } else {
            console.error('Invalid start date/time:', startDateTimeLuxon.invalidExplanation);
        }
    }

    // Extract end date and time
    const endMatch = html.match(endDateRegex);
    if (endMatch) {
        console.log('End date match found:', endMatch[0]);
        const [, year, month, day, hour, minute, period] = endMatch;
        let hourNum = parseInt(hour);
        if (period.toLowerCase() === 'pm' && hourNum !== 12) hourNum += 12;
        if (period.toLowerCase() === 'am' && hourNum === 12) hourNum = 0;

        // Create DateTime in EST timezone then convert to JavaScript Date
        const endDateTimeLuxon = DateTime.fromObject(
            {
                year: parseInt(year),
                month: parseInt(month),
                day: parseInt(day),
                hour: hourNum,
                minute: parseInt(minute)
            },
            { zone: 'America/New_York' }
        );

        if (endDateTimeLuxon.isValid) {
            endTime = endDateTimeLuxon.toJSDate();
            console.log('Parsed end time (EST):', endTime);
        } else {
            console.error('Invalid end date/time:', endDateTimeLuxon.invalidExplanation);
        }
    }

    if (!startMatch && !endMatch) {
        console.log('No Marx Cafe date format found');
    }

    return {
        start: startTime,
        end: endTime
    };
}

function extractLocationFromHTML(root: any) {
    // Look for Marx Cafe address pattern
    const text = root.textContent || '';
    const addressMatch = text.match(/3203\s+MT\.?\s*PLEASANT\s+ST\s+NW[^,]*,?\s*WASHINGTON\s+DC\s+\d{5}/i);
    if (addressMatch) {
        return 'Marx Cafe, ' + addressMatch[0];
    }
    return 'Marx Cafe, 3203 MT. Pleasant St NW, Washington DC';
}

