import React, { useState, useEffect } from 'react';
import Image from 'next/image';
import Dialog from '@/components/Dialog';
import { useTranslation } from '@/hooks/useTranslation';
import { HardcoverClient } from '@/services/sync/HardcoverClient';
import { HardcoverBook } from '@/services/sync/hardcoverTypes';
import { Book } from '@/types/book';

interface HardcoverBookMatcherProps {
  book: Book;
  client: HardcoverClient;
  isOpen: boolean;
  onMatch: (hardcoverBookId: string) => void;
  onClose: () => void;
}

const HardcoverBookMatcher: React.FC<HardcoverBookMatcherProps> = ({
  book,
  client,
  isOpen,
  onMatch,
  onClose,
}) => {
  const _ = useTranslation();
  const [searchResults, setSearchResults] = useState<HardcoverBook[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');


  const handleSearch = async (query: string) => {
    if (!query.trim()) return;

    setIsSearching(true);
    try {
      const results = await client.searchBooks(query);
      setSearchResults(results);
    } catch (error) {
      console.error('Hardcover search failed:', error);
      setSearchResults([]);
    }
    setIsSearching(false);
  };

  const handleSelectBook = async (hardcoverBook: HardcoverBook) => {
    try {
      // Check if book is already in user's library
      const userBook = await client.getUserBook(hardcoverBook.id);
      let userBookId: string | null;

      if (!userBook) {
        // Add to library with "Currently Reading" status
        userBookId = await client.addBookToLibrary(hardcoverBook.id);
      } else {
        userBookId = userBook.id;
      }

      if (userBookId) {
        onMatch(userBookId);
        onClose();
      }
    } catch (error) {
      console.error('Failed to add book to Hardcover library:', error);
    }
  };

  useEffect(() => {
    if (isOpen) {
      const initialQuery = book.title;
      setSearchQuery(initialQuery);
      handleSearch(initialQuery);
    }
  }, [isOpen, book]);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={_('Match Book with Hardcover')}
      boxClassName='sm:!min-w-[600px] sm:max-h-[80vh]'
    >
      <div className='flex flex-col gap-4 p-4'>
        <div className='text-base-content/70 text-sm'>
          <p className='font-medium'>{_('Current Book:')}</p>
          <p className='mt-1'>
            {book.title} {_('by')} {book.author}
          </p>
        </div>

        <div className='form-control'>
          <label className='label py-1'>
            <span className='label-text font-medium'>{_('Search Hardcover')}</span>
          </label>
          <div className='flex gap-2'>
            <input
              type='text'
              placeholder={_('Search by title or author')}
              className='input input-bordered h-12 flex-1 focus:outline-none focus:ring-0'
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch(searchQuery)}
            />
            <button
              className='btn btn-primary h-12 min-h-12'
              onClick={() => handleSearch(searchQuery)}
              disabled={isSearching || !searchQuery.trim()}
            >
              {isSearching ? <span className='loading loading-spinner'></span> : _('Search')}
            </button>
          </div>
        </div>

        <div className='max-h-96 overflow-y-auto'>
          {searchResults.length > 0 ? (
            <div className='space-y-2'>
              {searchResults.map((hb) => (
                <div
                  key={hb.id}
                  className='card bg-base-200 cursor-pointer transition-colors hover:bg-base-300'
                  onClick={() => handleSelectBook(hb)}
                >
                  <div className='card-body flex-row items-center gap-3 p-3'>
                    {hb.image_url && (
                      <div className='flex-shrink-0'>
                        <Image
                          src={hb.image_url}
                          alt={hb.title}
                          width={48}
                          height={72}
                          className='rounded shadow-sm'
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      </div>
                    )}
                    <div className='flex-1 overflow-hidden'>
                      <h3 className='truncate font-semibold'>{hb.title}</h3>
                      {hb.subtitle && (
                        <p className='text-base-content/70 truncate text-sm'>{hb.subtitle}</p>
                      )}
                      <p className='text-base-content/60 truncate text-sm'>
                        {hb.authors.map((a) => a.name).join(', ')}
                      </p>
                      {(hb.isbn_10 || hb.isbn_13) && (
                        <p className='text-base-content/50 text-xs'>
                          ISBN: {hb.isbn_13 || hb.isbn_10}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className='text-base-content/60 py-8 text-center text-sm'>
              {isSearching ? _('Searching...') : _('No results found. Try a different search.')}
            </div>
          )}
        </div>

        <div className='flex gap-2'>
          <button className='btn btn-ghost flex-1' onClick={onClose}>
            {_('Cancel')}
          </button>
        </div>

        <p className='text-base-content/60 text-center text-xs'>
          {_('Selecting a book will add it to your Hardcover library and link it with this book.')}
        </p>
      </div>
    </Dialog>
  );
};

export default HardcoverBookMatcher;
