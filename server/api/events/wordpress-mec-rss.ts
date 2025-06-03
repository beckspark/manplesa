import eventSourcesJSON from '@/assets/event_sources.json';
import { logTimeElapsedSince, serverCacheMaxAgeSeconds, serverStaleWhileInvalidateSeconds, serverFetchHeaders, applyEventTags } from '@/utils/util';
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
    const body = await fetchWordpressMECRssEvents();
    logTimeElapsedSince(startTime, 'Wordpress MEC RSS: events fetched.');
    return {
        body
    }
}, {
    maxAge: serverCacheMaxAgeSeconds,
    staleMaxAge: serverStaleWhileInvalidateSeconds,
    swr: true,
});

async function fetchWordpressMECRssEvents() {
    console.log('Fetching wordpress MEC RSS events...');
    let wordpressMECRssSources: EventNormalSource[] | null = await useStorage().getItem('wordpressMECRssSources');

    try {
        wordpressMECRssSources = await Promise.all(
            eventSourcesJSON.wordpressMECRss.map(async (source) => {
                
                const response = await fetch(source.url, { headers: serverFetchHeaders });
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status} from ${source.url}`);
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

                const mecEvents = items.map(itemElement => convertMECRssEventToFullCalendarEvent(itemElement, source, 'America/New_York'));

                return {
                    events: mecEvents,
                    city: source.city,
                    name: source.name,
                } as EventNormalSource;
            })
        );
        await useStorage().setItem('wordpressMECRssSources', wordpressMECRssSources);
    } catch (error) {
        console.error('Error fetching wordpress MEC RSS events:', error);
        
        return [];
    }
    return wordpressMECRssSources;
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

    // Format title
	if (source.prefixTitle) { title = source.prefixTitle + title; }
	if (source.suffixTitle) { title += source.suffixTitle; }

    // Add tags
    const tags = applyEventTags(source, title, cleanDescription || '');
    if (isDevelopment) title = tags.length + " " + title;

    return {
        title: title,
        start: eventStart,
        end: eventEnd,
        url: link,
        description: cleanDescription,
        location: locationName,
		images: imageUrl ? [imageUrl] : [], //if it's an image, attach it (add checking logic later)
        tags: tags,
        extendedProps: {
            category: category,
            creator: creator
        }
    };
}