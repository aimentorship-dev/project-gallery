// Data service for progressive loading
class DataService {
  constructor() {
    this.data = {
      projects: [],
      topics: [],
      tags: [],
      tagsMap: {}
    };
    this.loading = {
      projects: false,
      topics: false,
      tags: false
    };
    this.callbacks = {
      projects: [],
      topics: [],
      tags: []
    };
  }

  // Both loaders below call this; share one network request between them rather
  // than downloading the ~1 MB data.json twice on every visit.
  fetchDataJson() {
    if (!this._dataJson) {
      this._dataJson = this._fetchDataJson().catch(err => { this._dataJson = null; throw err; });
    }
    return this._dataJson;
  }

  // Helper method to fetch data.json with multiple path attempts
  async _fetchDataJson() {
    const paths = [
      '/data.json',
      './data.json', 
      'data.json',
      '/dist/data.json',
      './dist/data.json'
    ];
    
    for (const path of paths) {
      try {
        console.log(`Trying to fetch data from: ${path}`);
        const response = await fetch(path);
        if (response.ok) {
          console.log(`Successfully fetched data from: ${path}`);
          return await response.json();
        }
      } catch (error) {
        console.log(`Failed to fetch from ${path}:`, error);
      }
    }
    
    throw new Error('Could not fetch data.json from any path');
  }

  // Load topics and tags first (lightweight data for filters)
  async loadFilterData() {
    if (this.loading.topics) return this.waitForData('topics');
    
    this.loading.topics = true;
    
    try {
      const fullData = await this.fetchDataJson();
      
      // Extract lightweight filter data
      this.data.topics = fullData.topics || [];
      this.data.tags = fullData.tags || [];
      this.data.tagsMap = fullData.tagsMap || {};
      
      this.loading.topics = false;
      this.notifyCallbacks('topics');
      
      return this.data;
    } catch (error) {
      console.error('Failed to load filter data:', error);
      this.loading.topics = false;
      throw error;
    }
  }

  // Load projects data (heavier data)
  async loadProjects() {
    if (this.loading.projects) return this.waitForData('projects');
    
    this.loading.projects = true;
    
    try {
      const fullData = await this.fetchDataJson();
      
      this.data.projects = fullData.projects || [];
      this.loading.projects = false;
      this.notifyCallbacks('projects');
      
      return this.data.projects;
    } catch (error) {
      console.error('Failed to load projects:', error);
      this.loading.projects = false;
      throw error;
    }
  }

  // Get cached data
  getTopics() {
    return this.data.topics;
  }

  getTags() {
    return this.data.tags;
  }

  getTagsMap() {
    return this.data.tagsMap;
  }

  getProjects() {
    return this.sortProjects([...this.data.projects]);
  }

  // Check if data is loaded
  isTopicsLoaded() {
    return this.data.topics.length > 0;
  }

  isProjectsLoaded() {
    return this.data.projects.length > 0;
  }

  // Subscribe to data loading events
  onTopicsLoaded(callback) {
    if (this.isTopicsLoaded()) {
      callback(this.data.topics);
    } else {
      this.callbacks.topics.push(callback);
    }
  }

  onProjectsLoaded(callback) {
    if (this.isProjectsLoaded()) {
      callback(this.data.projects);
    } else {
      this.callbacks.projects.push(callback);
    }
  }

  // Wait for specific data to load
  waitForData(type) {
    return new Promise((resolve) => {
      this.callbacks[type].push(resolve);
    });
  }

  // Notify callbacks when data is loaded
  notifyCallbacks(type) {
    this.callbacks[type].forEach(callback => {
      try {
        callback(this.data[type]);
      } catch (error) {
        console.error(`Error in callback for ${type}:`, error);
      }
    });
    this.callbacks[type] = [];
  }

  // Sort projects with published ones first, then by newest date
  sortProjects(projects) {
    return projects.sort((a, b) => {
      // First priority: published projects come first
      const aPublished = a.published === true ? 1 : 0;
      const bPublished = b.published === true ? 1 : 0;

      if (aPublished !== bPublished) {
        return bPublished - aPublished; // Published projects first
      }

      // Second priority: sort by date (newest first)
      const aDate = this.parseProjectDate(a);
      const bDate = this.parseProjectDate(b);

      return bDate - aDate; // Newest first
    });
  }

  // Parse project date from project_yr and project_quarter
  parseProjectDate(project) {
    // Try to get date from standard date fields first
    if (project.date) {
      return new Date(project.date);
    }
    if (project.created_at) {
      return new Date(project.created_at);
    }

    // Parse from project_yr and project_quarter
    if (project.project_yr) {
      const year = parseInt(project.project_yr);

      // If no quarter specified, assume it's a current/recent project
      if (!project.project_quarter || project.project_quarter === 'undefined') {
        // Treat projects without quarters as very recent (current year, future date)
        return new Date(year + 1, 0, 1); // January 1st of next year (very recent)
      }

      const quarter = project.project_quarter.toLowerCase();

      // Convert quarter to month (approximate)
      let month = 1; // Default to January
      switch (quarter) {
        case 'spring':
          month = 3; // March
          break;
        case 'summer':
          month = 6; // June
          break;
        case 'fall':
          month = 9; // September
          break;
        case 'winter':
          month = 12; // December
          break;
      }

      return new Date(year, month - 1, 1); // month is 0-indexed in Date constructor
    }

    // Fallback to epoch if no date info
    return new Date(0);
  }

  // Filter projects by active filters
  filterProjects(activeFilters) {
    if (!this.isProjectsLoaded()) {
      return [];
    }

    const filteredProjects = this.data.projects.filter(project => {
      return activeFilters.every(filter => {
        const filterValue = filter.value.toLowerCase();
        
        // Check if project matches domain filter
        if (project.domains && project.domains.some(domain => 
          domain.toLowerCase().includes(filterValue)
        )) {
          return true;
        }
        
        // Check if project matches tag filter
        if (project.tags && project.tags.some(tag => 
          tag.toLowerCase().includes(filterValue)
        )) {
          return true;
        }
        
        // Check if project matches title or description
        if (project.project_title && project.project_title.toLowerCase().includes(filterValue)) {
          return true;
        }
        
        if (project.headline && project.headline.toLowerCase().includes(filterValue)) {
          return true;
        }
        
        return false;
      });
    });

    // Sort the filtered results
    return this.sortProjects(filteredProjects);
  }
}

// Create singleton instance
const dataService = new DataService();

export default dataService;