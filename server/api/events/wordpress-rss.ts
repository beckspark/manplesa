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
                            return await enhanceEventWithPageData(event, source);
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

    // Extract date from DC Jazz Jam titles before cleaning
    let extractedDate = null;
    if (source.name === 'DC Jazz Jam') {
        // Extract date before cleaning title
        const dcJazzDateTime = extractDCJazzJamDateTime(title, cleanDescription || '');
        if (dcJazzDateTime.start) {
            extractedDate = dcJazzDateTime;
        }
        // Remove patterns like "Sunday 9/21/25: " from the beginning
        title = title.replace(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+\d{1,2}\/\d{1,2}\/\d{2,4}:\s*/i, '');
    }

    // Format title
    if (source.prefixTitle) { title = source.prefixTitle + title; }
    if (source.suffixTitle) { title += source.suffixTitle; }

    // Add tags
    const tags = applyEventTags(source, title, cleanDescription || '');
    if (isDevelopment) title = tags.length + " " + title;

    // Use extracted dates if available (DC Jazz Jam), otherwise use publication dates
    const finalStart = extractedDate?.start || eventStart;
    const finalEnd = extractedDate?.end || eventEnd;

    return {
        id: finalStart ? formatTitleAndDateToID(finalStart, title) : null,
        title: title,
        org: source.name,
        start: finalStart,
        end: finalEnd,
        url: link,
        description: description,
        location: null, // Standard RSS doesn't have location info
        images: imageUrl ? [imageUrl] : [],
        tags: tags,
        extendedProps: {
            category: null, // Standard RSS doesn't have category info
            creator: creator,
            needsDateExtraction: !extractedDate // Only needs enhancement if we didn't extract date
        }
    };
}

async function enhanceEventWithPageData(event: any, source: any) {
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
        const dateTimeInfo = extractDateTimeFromHTML(html, root, source, event);

        if (dateTimeInfo.start) {
            event.start = dateTimeInfo.start;
            event.end = dateTimeInfo.end || dateTimeInfo.start;
            // Update ID with proper date
            event.id = formatTitleAndDateToID(dateTimeInfo.start, event.title);
        }

        // Extract location information based on source
        const location = extractLocationFromHTML(root, source);
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

function extractDateTimeFromHTML(html: string, root: any, source?: any, event?: any) {
    // Handle DC Jazz Jam events - extract date from title and description
    if (source?.name === 'DC Jazz Jam' && event?.title) {
        const dcJazzDateTime = extractDCJazzJamDateTime(event.title, event.description);
        if (dcJazzDateTime.start) {
            return dcJazzDateTime;
        }
    }

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

function extractLocationFromHTML(root: any, source?: any) {
    const text = root.textContent || '';

    // Handle DC Jazz Jam events (they happen at Haydee's)
    if (source?.name === 'DC Jazz Jam') {
        // Look for Haydee's address in the content
        const haydeeMatch = text.match(/haydee'?s[^.]*3102\s+mount\s+pleasant\s+street\s+nw/i);
        if (haydeeMatch) {
            return "Haydee's, 3102 Mount Pleasant Street NW, Washington DC";
        }
        // Default for DC Jazz Jam
        return "Haydee's, 3102 Mount Pleasant Street NW, Washington DC";
    }

    // Handle Marx Cafe events
    const marxMatch = text.match(/3203\s+MT\.?\s*PLEASANT\s+ST\s+NW[^,]*,?\s*WASHINGTON\s+DC\s+\d{5}/i);
    if (marxMatch) {
        return 'Marx Cafe, ' + marxMatch[0];
    }
    return 'Marx Cafe, 3203 MT. Pleasant St NW, Washington DC';
}

function extractDCJazzJamDateTime(title: string, description?: string) {
    // Extract date from title pattern: "Sunday 9/21/25: [event details]"
    const dateMatch = title.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);

    if (!dateMatch) {
        return { start: null, end: null };
    }

    const [, month, day, year] = dateMatch;
    // Convert 2-digit year to 4-digit (25 -> 2025)
    const fullYear = year.length === 2 ? parseInt('20' + year) : parseInt(year);

    // Try to extract time from both title and description
    const textToSearch = (title + ' ' + (description || '')).toLowerCase();

    // Try to extract time from title/description - look for patterns like "6:30-9:00pm", "7:00 PM", etc.
    let startHour = 18;  // Default 6:30 PM
    let startMinute = 30;
    let endHour = 21;    // Default 9:00 PM
    let endMinute = 0;

    // Look for time ranges like "6:30-9:00pm" or "7:00-10:00 PM"
    const timeRangeMatch = textToSearch.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*(pm|am)?/i);
    if (timeRangeMatch) {
        const [, startH, startM, endH, endM, period] = timeRangeMatch;
        startHour = parseInt(startH);
        startMinute = parseInt(startM);
        endHour = parseInt(endH);
        endMinute = parseInt(endM);

        // Handle AM/PM conversion
        if (period && period.toLowerCase() === 'pm') {
            if (startHour !== 12) startHour += 12;
            if (endHour !== 12) endHour += 12;
        } else if (period && period.toLowerCase() === 'am') {
            if (startHour === 12) startHour = 0;
            if (endHour === 12) endHour = 0;
        }
    } else {
        // Look for single time like "6:30pm" and assume 2.5 hour duration
        const singleTimeMatch = textToSearch.match(/(\d{1,2}):(\d{2})\s*(pm|am)/i);
        if (singleTimeMatch) {
            const [, hour, minute, period] = singleTimeMatch;
            startHour = parseInt(hour);
            startMinute = parseInt(minute);

            if (period.toLowerCase() === 'pm' && startHour !== 12) {
                startHour += 12;
            } else if (period.toLowerCase() === 'am' && startHour === 12) {
                startHour = 0;
            }

            // Default 2.5 hour duration
            endHour = startHour + 2;
            endMinute = startMinute + 30;
            if (endMinute >= 60) {
                endHour++;
                endMinute -= 60;
            }
        }
    }

    const startDateTime = DateTime.fromObject(
        {
            year: fullYear,
            month: parseInt(month),
            day: parseInt(day),
            hour: startHour,
            minute: startMinute
        },
        { zone: 'America/New_York' }
    );

    const endDateTime = DateTime.fromObject(
        {
            year: fullYear,
            month: parseInt(month),
            day: parseInt(day),
            hour: endHour,
            minute: endMinute
        },
        { zone: 'America/New_York' }
    );

    if (startDateTime.isValid && endDateTime.isValid) {
        console.log(`DC Jazz Jam: Extracted date ${month}/${day}/${fullYear} ${startHour}:${startMinute.toString().padStart(2,'0')}-${endHour}:${endMinute.toString().padStart(2,'0')} EST`);
        return {
            start: startDateTime.toJSDate(),
            end: endDateTime.toJSDate()
        };
    }

    return { start: null, end: null };
}

