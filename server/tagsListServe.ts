import eventSourcesJSON from '@/assets/event_sources.json';

export interface Tag {
  name: string;
  isVisible: boolean;
  isHidden: boolean;
  isHeader: boolean;
}

// Helper function to extract source names from URLs
function extractSourceNames(urls: string[]): string[] {
  return urls.map(url => {
    const parts = url.split('/');
    return parts[parts.length - 1]; // Returns the last segment after the last '/'
  });
}

export function getAllTags(): Tag[] {
  const tagsSet = new Set<string>();
  
  // Extract the source names from the configuration
  const sourceNames = extractSourceNames(eventSourcesJSON.appConfig.eventApiToGrab);

  // Iterate over each source type in eventSourcesJSON using the source names
  sourceNames.forEach(sourceName => {
    const eventSourceArray = eventSourcesJSON[sourceName];
    if (eventSourceArray) {
      eventSourceArray.forEach(source => {
        source.filters.forEach(filter => {
          if (Array.isArray(filter) && filter.length > 0) {
            const firstFilterElement = filter[0];
            if (Array.isArray(firstFilterElement)) {
              // If the first element itself is an array, iterate through it
              firstFilterElement.forEach(subTag => {
                if (typeof subTag === 'string') {
                  tagsSet.add(subTag);
                }
              });
            } else if (typeof firstFilterElement === 'string') {
              // If it's a single string, add it directly
              tagsSet.add(firstFilterElement);
            }
          }
        });
      });
    }
  });

  const tagsHidden = new Set(eventSourcesJSON.appConfig.tagsHidden);
  const tagsHeaderMap = new Map(eventSourcesJSON.appConfig.tagsHeader.map(tag => [tag.name, tag]));
  const tagsToShowMap = new Map();

  // Flatten tagsToShow and create a map for default values
  eventSourcesJSON.appConfig.tagsToShow.flat().forEach(tag => {
    tagsToShowMap.set(tag.name, tag);
  });

  // Convert the set of tags into an array of Tag objects, setting visibility based on defaultValue
  return Array.from(tagsSet).map(tag => {
    const headerTag = tagsHeaderMap.get(tag);
    const showTag = tagsToShowMap.get(tag);

    // Determine default visibility: use defaultValue from config, fallback to !tagsHidden.has(tag)
    let defaultVisible = !tagsHidden.has(tag);
    if (headerTag && headerTag.defaultValue !== undefined) {
      defaultVisible = headerTag.defaultValue === "true";
    } else if (showTag && showTag.defaultValue !== undefined) {
      defaultVisible = showTag.defaultValue === "true";
    }

    return {
      name: tag,
      isVisible: defaultVisible,  //Whether a tag is visible, respects defaultValue from config
      isHidden: tagsHidden.has(tag),    //Whether a tag indicates that it ought to be hidden. This is permanent, if a tag has isHidden true then any event with it ought to be hidden forever
      isHeader: tagsHeaderMap.has(tag)     //Whether a tag is a header tag, this means that it's a pre-requisite that atleast one visible Header tag should be on an event for the event to be visible at all.
    };
  });
}
