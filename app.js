const express = require('express');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const SpotifyStrategy = require('passport-spotify').Strategy;
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

app.set('view engine', 'ejs');

// Middleware to parse incoming form data 
app.use(bodyParser.urlencoded({ extended: true }));

// Middleware to parse incoming JSON data
app.use(bodyParser.json());

app.use(session({
  secret: 'spotify-secret', // spotify secret id for cookies
  resave: true, // saves session
  saveUninitialized: true, 
  cookie: { secure: false } 
}));

// set up passport(authentication middleware for node.js) Spotify OAuth
app.use(passport.initialize());
app.use(passport.session());

// serialize user sessions
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// set up the Spotify OAuth
passport.use(new SpotifyStrategy(
  {
    clientID: '257242d7ca8b4d2db33558dd8c6432ab', // Spotify Client ID from website
    clientSecret: '03d9e9c89ee34f2bba9737fa4bf37832', // Spotify Client Secret
    callbackURL: 'http://localhost:3000/callback' // Redirect URI/need to buy domain
  },
  (accessToken, refreshToken, expires_in, profile, done) => {
    // the authenticated user profile and access token
    console.log('Access Token:', accessToken);  // Log the access token
    console.log('Profile:', profile);  // Log the user's profile
    return done(null, { profile, accessToken });
  }
));


app.use(express.static('public'));

// route to index.html(homepage)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route to handle authentication with Spotify
app.get('/auth/spotify', passport.authenticate('spotify', {
  scope: ['user-read-email', 'user-read-private', 'user-top-read', 'playlist-modify-public', 'user-read-recently-played', 'playlist-modify-private']
}));

// Callback route after successful authentication
app.get('/callback', passport.authenticate('spotify', { failureRedirect: '/' }), (req, res) => {
  console.log('User authenticated:', req.user);
  res.redirect('/menu');
});

app.get('/menu', ensureAuthenticated, (req, res) => {
    res.render('main-menu');
  });

// Middleware to check if the user is authenticated
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.redirect('/auth/spotify'); // redirect to login if not authenticated
}

app.get('/dashboard', ensureAuthenticated, async (req, res) => {
    const accessToken = req.user.accessToken;
  
    try {
      // Fetch recently played tracks (last 50 tracks or 24 hours)
      const recentTracksResponse = await axios.get('https://api.spotify.com/v1/me/player/recently-played', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: { limit: 50 }
      });
  
      const recentTracks = recentTracksResponse.data.items;
  
      // Handle case when there are no recent tracks
      if (recentTracks.length === 0) {
        return res.render('dashboard', {
          listeningTimeData: [],
          topGenres: [],
          genreData: [],
          message: 'No recent listening data available.'
        });
      }
  
      // Group listening time by hour
      const listeningTimeByHour = new Array(24).fill(0);
      const artistIds = [];
  
      // Collect artist IDs and calculate listening time per hour
      recentTracks.forEach(trackItem => {
        const playedAt = new Date(trackItem.played_at);
        const hour = playedAt.getHours();
        const durationInMinutes = trackItem.track.duration_ms / (1000 * 60);
  
        listeningTimeByHour[hour] += durationInMinutes;
  
        // Add the artist's ID to fetch batch
        trackItem.track.artists.forEach(artist => {
          if (!artistIds.includes(artist.id)) {
            artistIds.push(artist.id);
          }
        });
      });
  
      // Fetch artist data in parallel using Promise.all
      const artistRequests = artistIds.map(artistId =>
        axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        })
      );
      
      // Wait for all artist data to be fetched
      const artistResponses = await Promise.all(artistRequests);
  
      // Count genres based on artist data
      const genreCount = {};
      artistResponses.forEach(artistResponse => {
        const artistGenres = artistResponse.data.genres;
        artistGenres.forEach(genre => {
          if (!genreCount[genre]) {
            genreCount[genre] = 0;
          }
          genreCount[genre] += 1;
        });
      });
  
      const topGenres = Object.keys(genreCount);
      const genreData = Object.values(genreCount);
  
      // Render the dashboard with updated data
      res.render('dashboard', {
        listeningTimeData: listeningTimeByHour,
        topGenres,
        genreData
      });
    } catch (error) {
      console.error('Error fetching dashboard data:', error.response ? error.response.data : error.message);
      res.status(500).send('Error fetching dashboard data');
    }
  });

app.get('/logout', (req, res) => {
    req.logout((err) => {
      if (err) {
        return next(err);
      }
      req.session.destroy((err) => {
        if (err) {
          console.error('Error destroying session:', err);
        } else {
          console.log('Session destroyed, redirecting to login.');
        }
        res.redirect('/'); // Redirect to the login screen
      });
    });
  });

// route to get top tracks
app.get('/get-top-tracks', (req, res) => {
    const accessToken = req.user.accessToken;
  
    axios.get('https://api.spotify.com/v1/me/top/tracks', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        limit: 50,
        time_range: 'long_term' // Change to 'short_term' 4 weeks, 'medium_term' 6 months, or 'long_term' all time
      }
    }).then(response => {
      res.render('top-tracks', { tracks: response.data.items });
    }).catch(error => {
      console.error('Error fetching top tracks:', error);
      res.status(500).send('Error fetching top tracks');
    });
});

// route to get top artists 
app.get('/get-top-artists', ensureAuthenticated, (req, res) => {
    const accessToken = req.user.accessToken;
  
    axios.get('https://api.spotify.com/v1/me/top/artists', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      params: {
        limit: 50, // up to 50
        time_range: 'long_term' 
      }
    }).then(async response => {
      const artists = response.data.items;
  
      // most listened track for each artist
      const artistWithTracksPromises = artists.map(async artist => {
        const topTracks = await axios.get(`https://api.spotify.com/v1/artists/${artist.id}/top-tracks`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          params: {
            market: 'US' 
          }
        });
  
        // Assume the first track is the most listened
        const mostListenedTrack = topTracks.data.tracks[0];
        return { ...artist, mostListenedTrack };
      });
  

      const artistsWithTracks = await Promise.all(artistWithTracksPromises);
  
      // add artists with their top track
      res.render('top-artists', { artists: artistsWithTracks });
    }).catch(error => {
      console.error('Error fetching top artists:', error);
      res.status(500).send('Error fetching top artists');
    });
  });

  app.get('/get-top-albums', ensureAuthenticated, async (req, res) => {
    const accessToken = req.user.accessToken;
  
    try {
      const tracksResponse = await axios.get('https://api.spotify.com/v1/me/top/tracks', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        params: {
          limit: 50, 
          time_range: 'long_term' 
        }
      });
  
      const tracks = tracksResponse.data.items;
  
      // Group tracks by album
      const albumMap = {};
  
      tracks.forEach(track => {
        const album = track.album;
        if (!albumMap[album.id]) {
          albumMap[album.id] = {
            ...album,
            tracks: [track]
          };
        } else {
          albumMap[album.id].tracks.push(track);
        }
      });
  
      // convert the album to an array
      const topAlbums = Object.values(albumMap);
  
      res.render('top-albums', { albums: topAlbums });
    } catch (error) {
      console.error('Error fetching top tracks or grouping albums:', error);
      res.status(500).send('Error fetching top albums');
    }
  });

// Helper function to create playlists
async function createMoodPlaylists(userId, accessToken, { energeticTracks, mellowTracks, lowEnergyTracks, energeticPlaylistName, mellowPlaylistName, lowEnergyPlaylistName }) {
    try {
      // create high energy playlist
      if (energeticTracks.length > 0) {
        const energeticPlaylistResponse = await axios.post(`https://api.spotify.com/v1/users/${userId}/playlists`, {
          name: energeticPlaylistName,
          description: "Energetic playlist created from your liked songs",
          public: false
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
  
        const energeticPlaylistId = energeticPlaylistResponse.data.id;
        await axios.post(`https://api.spotify.com/v1/playlists/${energeticPlaylistId}/tracks`, {
          uris: energeticTracks
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        console.log("Created Energetic playlist");
      }
  
      // create mellow playlist
      if (mellowTracks.length > 0) {
        const mellowPlaylistResponse = await axios.post(`https://api.spotify.com/v1/users/${userId}/playlists`, {
          name: mellowPlaylistName,
          description: "Mellow playlist created from your liked songs",
          public: false
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
  
        const mellowPlaylistId = mellowPlaylistResponse.data.id;
        await axios.post(`https://api.spotify.com/v1/playlists/${mellowPlaylistId}/tracks`, {
          uris: mellowTracks
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        console.log("Created Mellow playlist");
      }
  
      // create low energy playlist
      if (lowEnergyTracks.length > 0) {
        const lowEnergyPlaylistResponse = await axios.post(`https://api.spotify.com/v1/users/${userId}/playlists`, {
          name: lowEnergyPlaylistName,
          description: "Low energy playlist created from your liked songs",
          public: false
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
  
        const lowEnergyPlaylistId = lowEnergyPlaylistResponse.data.id;
        await axios.post(`https://api.spotify.com/v1/playlists/${lowEnergyPlaylistId}/tracks`, {
          uris: lowEnergyTracks
        }, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
        console.log("Created Low Energy playlist");
      }
    } catch (error) {
      console.error('Error creating playlists:', error.response ? error.response.data : error.message);
      throw error;
    }
  }
  

  app.post('/create-playlist', ensureAuthenticated, async (req, res) => {
    const accessToken = req.user.accessToken;
    const userId = req.user.profile.id; // User's Spotify ID
  
    // playlist names from the form submission
    const energeticPlaylistName = req.body['energetic-name'] || 'Energetic Vibes';
    const mellowPlaylistName = req.body['mellow-name'] || 'Mellow Tunes';
    const lowEnergyPlaylistName = req.body['low-energy-name'] || 'Chill Vibes';
  
    try {
      // grab all liked songs and loop every 50
      let allLikedTracks = [];
      let limit = 50;
      let offset = 0;
      let totalSongs = 0;
  
      do {
        const likedSongsResponse = await axios.get('https://api.spotify.com/v1/me/tracks', {
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          params: { limit, offset }
        });
  
        const likedTracks = likedSongsResponse.data.items;
        totalSongs = likedSongsResponse.data.total;
        allLikedTracks.push(...likedTracks);
  
        offset += limit;
      } while (offset < totalSongs);
  
      // Arrays for tracks based on mood
      const energeticTracks = [];
      const mellowTracks = [];
      const lowEnergyTracks = [];
  
      // fetch audio features for each liked track
      for (const trackItem of allLikedTracks) {
        const trackId = trackItem.track.id;
        const audioFeaturesResponse = await axios.get(`https://api.spotify.com/v1/audio-features/${trackId}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`
          }
        });
  
        const { valence, energy } = audioFeaturesResponse.data;
  
        if (valence > 0.6 && energy > 0.6) {
          energeticTracks.push(trackItem.track.uri);
        } else if (valence < 0.4 && energy < 0.5) {
          lowEnergyTracks.push(trackItem.track.uri);
        } else {
          mellowTracks.push(trackItem.track.uri);
        }
      }
  
      // create playlists for the categorized tracks
      await createMoodPlaylists(userId, accessToken, {
        energeticTracks,
        mellowTracks,
        lowEnergyTracks,
        energeticPlaylistName,
        mellowPlaylistName,
        lowEnergyPlaylistName
      });
  
      res.send('Playlists created successfully!');
    } catch (error) {
      console.error('Error creating playlists:', error.response ? error.response.data : error.message);
      res.status(500).send('Error creating playlists');
    }
  });

// start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});